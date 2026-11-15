import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { api, apiAsUser, cleanupTestUsers, createTestUser, isDenied, ORG, psql } from "./harness";

/**
 * Exploitation des envois (J39) par la Data API : arrêt d'urgence par entreprise, rejeu humain d'une dead letter, alerte d'échec.
 * Tests ré-exécutables : comptes et organisations uniques par exécution ; jobs et alertes créés sont supprimés.
 */

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
type Account = { id: string; email: string };
const createdUsers: string[] = [];

async function newAccount(label: string): Promise<Account> {
  const account = await createTestUser(label);
  createdUsers.push(account.id);
  return account;
}
const rpcAs = (user: Account, fn: string, args: Record<string, unknown>) => apiAsUser(user.id, "POST", `rpc/${fn}`, args);
const one = (sql: string): string => psql(sql).trim().split("\n").filter((l) => l.length > 0)[0] ?? "";

let owner: Account;
let sales: Account;
let other: Account;
let orgA: string;
let orgB: string;

async function deadLetter(org: string, kind: string, k: string): Promise<string> {
  const id = one(
    `insert into public.jobs (organization_id, kind, payload, idempotency_key, status) values ('${org}', '${kind}', '{}', 'so-${run}-${k}', 'queued') returning id`,
  );
  psql(`update public.jobs set status = 'dead_letter', finished_at = now(), last_error = 'provider_error' where id = '${id}'`);
  return id;
}

beforeAll(async () => {
  [owner, sales, other] = await Promise.all([newAccount("so-owner"), newAccount("so-sales"), newAccount("so-other")]);
  const a = await rpcAs(owner, "create_organization", { p_name: `SO A ${run}`, p_creation_key: `so-a-${run}` });
  const b = await rpcAs(other, "create_organization", { p_name: `SO B ${run}`, p_creation_key: `so-b-${run}` });
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  orgA = a.body as string;
  orgB = b.body as string;
  const { createHash, randomBytes } = await import("node:crypto");
  const hash = createHash("sha256").update(randomBytes(32).toString("base64url")).digest("hex");
  expect((await rpcAs(owner, "create_invitation", { p_org: orgA, p_email: sales.email, p_role: "sales_agent", p_token_hash: hash })).status).toBe(200);
  expect((await rpcAs(sales, "accept_invitation", { p_token_hash: hash })).status).toBe(200);
});

afterAll(async () => {
  psql(`delete from public.notifications where organization_id in ('${orgA}', '${orgB}')`);
  psql(`delete from public.jobs where organization_id in ('${orgA}', '${orgB}')`);
  await cleanupTestUsers(createdUsers);
});

const paused = (org: string) => one(`select coalesce(settings ->> 'send_paused', 'false') from public.organizations where id = '${org}'`);

describe("arrêt d'urgence", () => {
  it("anon, commercial et propriétaire d'une AUTRE entreprise sont refusés", async () => {
    expect(isDenied(await api("anon", "POST", "rpc/set_send_emergency_stop", { p_org: orgA, p_paused: true }))).toBe(true);
    expect((await rpcAs(sales, "set_send_emergency_stop", { p_org: orgA, p_paused: true })).status).toBeGreaterThanOrEqual(400);
    expect((await rpcAs(other, "set_send_emergency_stop", { p_org: orgA, p_paused: true })).status).toBeGreaterThanOrEqual(400);
    expect(paused(orgA)).toBe("false");
  });

  it("le propriétaire arrête puis relance les envois, et l'action est auditée", async () => {
    expect((await rpcAs(owner, "set_send_emergency_stop", { p_org: orgA, p_paused: true })).status).toBeLessThan(300);
    expect(paused(orgA)).toBe("true");
    expect(paused(orgB)).not.toBe("true");
    expect(one(`select count(*) from public.audit_logs where organization_id = '${orgA}' and action = 'send.emergency_stop' and actor_id = '${owner.id}'`)).toBe("1");
    expect((await rpcAs(owner, "set_send_emergency_stop", { p_org: orgA, p_paused: false })).status).toBeLessThan(300);
    expect(paused(orgA)).toBe("false");
  });

  it("le Marketing Manager peut aussi arrêter les envois (ADR 014 ligne 9), pas l'analyste", async () => {
    const mk = await newAccount("so-mkt");
    const an = await newAccount("so-analyst");
    // membres ajoutés directement (le quota de sièges du plan limiterait les invitations de ce test)
    psql(`insert into public.organization_members (organization_id, user_id, role, status) values ('${orgA}', '${mk.id}', 'marketing_manager', 'active'), ('${orgA}', '${an.id}', 'analyst', 'active')`);
    expect((await rpcAs(an, "set_send_emergency_stop", { p_org: orgA, p_paused: true })).status).toBeGreaterThanOrEqual(400);
    expect(paused(orgA)).toBe("false");
    expect((await rpcAs(mk, "set_send_emergency_stop", { p_org: orgA, p_paused: true })).status).toBeLessThan(300);
    expect(paused(orgA)).toBe("true");
    expect((await rpcAs(owner, "set_send_emergency_stop", { p_org: orgA, p_paused: false })).status).toBeLessThan(300);
  });

  it("refuse une valeur nulle", async () => {
    expect((await rpcAs(owner, "set_send_emergency_stop", { p_org: orgA, p_paused: null })).status).toBeGreaterThanOrEqual(400);
  });
});

describe("rejeu d'une dead letter par un humain", () => {
  it("refuse le commercial, l'autre entreprise et l'anonyme", async () => {
    const id = await deadLetter(orgA, "noop", "replay-deny");
    expect(isDenied(await api("anon", "POST", "rpc/operator_replay_dead_letter", { p_org: orgA, p_job: id }))).toBe(true);
    expect((await rpcAs(sales, "operator_replay_dead_letter", { p_org: orgA, p_job: id })).status).toBeGreaterThanOrEqual(400);
    expect((await rpcAs(other, "operator_replay_dead_letter", { p_org: orgA, p_job: id })).status).toBeGreaterThanOrEqual(400);
    expect(one(`select status from public.jobs where id = '${id}'`)).toBe("dead_letter");
  });

  it("le propriétaire rejoue : le job repart en file, avec son identité dans l'audit", async () => {
    const id = await deadLetter(orgA, "noop", "replay-ok");
    const res = await rpcAs(owner, "operator_replay_dead_letter", { p_org: orgA, p_job: id });
    expect(res.status).toBe(200);
    expect(res.body).toBe(true);
    expect(one(`select status from public.jobs where id = '${id}'`)).toBe("queued");
    expect(one(`select count(*) from public.audit_logs where organization_id = '${orgA}' and action = 'job.replayed' and entity_id = '${id}' and actor_id = '${owner.id}'`)).toBe("1");
  });

  it("ne rejoue pas un job d'une autre entreprise, ni un job qui n'est pas en dead letter", async () => {
    const foreign = await deadLetter(orgB, "noop", "replay-foreign");
    expect((await rpcAs(owner, "operator_replay_dead_letter", { p_org: orgA, p_job: foreign })).body).toBe(false);
    expect(one(`select status from public.jobs where id = '${foreign}'`)).toBe("dead_letter");
    const queued = one(`insert into public.jobs (organization_id, kind, payload, idempotency_key) values ('${orgA}', 'noop', '{}', 'so-${run}-queued') returning id`);
    expect((await rpcAs(owner, "operator_replay_dead_letter", { p_org: orgA, p_job: queued })).body).toBe(false);
  });

  it("le propriétaire liste les dead letters de son entreprise seulement", async () => {
    const mine = await deadLetter(orgA, "noop", "list-mine");
    const theirs = await deadLetter(orgB, "noop", "list-theirs");
    const rows = await apiAsUser<{ id: string }[]>(owner.id, "GET", "jobs?status=eq.dead_letter&select=id");
    const ids = (rows.body as { id: string }[]).map((r) => r.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
    const asSales = await apiAsUser<{ id: string }[]>(sales.id, "GET", "jobs?status=eq.dead_letter&select=id");
    expect(asSales.body as unknown[]).toEqual([]);
  });
});

describe("alerte d'échec d'envoi", () => {
  it("un job d'envoi en dead letter alerte chaque owner / admin, sans donnée de contact, sans doublon", async () => {
    const id = await deadLetter(orgA, "send_message", "alert");
    expect(one(`select count(*) from public.notifications where organization_id = '${orgA}' and kind = 'send.failed' and recipient_id = '${owner.id}'`)).toBe("1");
    expect(one(`select count(*) from public.notifications where organization_id = '${orgA}' and kind = 'send.failed' and recipient_id = '${sales.id}'`)).toBe("0");
    expect(one(`select payload::text from public.notifications where organization_id = '${orgA}' and kind = 'send.failed' limit 1`)).toBe(`{"job_id": "${id}", "job_kind": "send_message"}`);
    // rejeu puis nouvel échec : une seule alerte par job et par destinataire
    psql(`update public.jobs set status = 'queued' where id = '${id}'`);
    psql(`update public.jobs set status = 'dead_letter' where id = '${id}'`);
    expect(one(`select count(*) from public.notifications where organization_id = '${orgA}' and kind = 'send.failed' and recipient_id = '${owner.id}'`)).toBe("1");
  });

  it("un job qui n'est pas un envoi n'alerte pas", async () => {
    const before = one(`select count(*) from public.notifications where organization_id = '${orgB}'`);
    await deadLetter(orgB, "noop", "no-alert");
    expect(one(`select count(*) from public.notifications where organization_id = '${orgB}'`)).toBe(before);
  });
});

describe("débit par (fournisseur, entreprise)", () => {
  const tag = `so${run}`;
  const CIPHERTEXT = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=";
  const NONCE = "QUJDREVGR0hJSktM";
  const svc = (fn: string, args: Record<string, unknown>) => api<unknown>("service", "POST", `rpc/${fn}`, args);
  const shared = (fn: string, args: Record<string, unknown>) => api<unknown>("shared", "POST", `rpc/${fn}`, args);

  afterAll(() => {
    psql(`
      set session_replication_role = replica;
      delete from public.messages where idempotency_key like '${tag}%';
      delete from public.conversations where contact_id in (select id from public.contacts where email_normalized like '%@${tag}.test');
      delete from public.channels where integration_id in (select id from public.integrations where external_account_id like 'rls${tag}%');
      delete from private.secrets where id in (select secret_ref from public.integrations where external_account_id like 'rls${tag}%');
      delete from public.integrations where external_account_id like 'rls${tag}%';
      delete from public.contacts where email_normalized like '%@${tag}.test';
    `);
  });

  it("les envois de l'heure sur un AUTRE canal e-mail de la même entreprise comptent dans le débit", async () => {
    const channels: string[] = [];
    for (const letter of ["a", "b"]) {
      const integration = await shared("create_provider_integration", { p_org: ORG.alpha, p_provider: "email", p_account: `rls${tag}${letter}`, p_scopes: [], p_secret_id: randomUUID(), p_ciphertext: CIPHERTEXT, p_nonce: NONCE, p_key_version: 1 });
      const channel = await shared("create_channel", { p_org: ORG.alpha, p_integration: String(integration.body), p_type: "email", p_sender: `${letter}@${tag}.test`, p_scope: [] });
      expect(channel.status).toBe(200);
      channels.push(String(channel.body));
    }
    const convs: string[] = [];
    for (const [i, channel] of channels.entries()) {
      psql(`insert into public.contacts (organization_id, name, email_raw, email_normalized) values ('${ORG.alpha}', 'SO ${tag} ${i}', 'c${i}@${tag}.test', 'c${i}@${tag}.test')`);
      const contact = one(`select id from public.contacts where organization_id = '${ORG.alpha}' and email_normalized = 'c${i}@${tag}.test'`);
      const conv = await svc("conversation_get_or_create", { p_org: ORG.alpha, p_contact: contact, p_channel: channel });
      convs.push(String((conv.body as { id: string }).id));
    }
    const record = async (conv: string, key: string) => {
      const r = await svc("message_record", { p_org: ORG.alpha, p_conversation: conv, p_direction: "outbound", p_provider_message_id: null, p_body: "corps", p_idempotency_key: `${tag}${key}`, p_event_at: null });
      expect(r.status).toBe(200);
      return String((r.body as { message_id: string }).message_id);
    };
    // deux envois réussis de l'heure sur le canal A, un message en attente sur le canal B
    for (const k of ["s1", "s2"]) {
      const id = await record(convs[0]!, k);
      psql(`set session_replication_role = replica; update public.messages set status = 'sent', sent_at = now() where id = '${id}';`);
    }
    const queued = await record(convs[1]!, "q1");
    const claim = await svc("message_send_claim", { p_org: ORG.alpha, p_message: queued });
    expect(claim.status).toBe(200);
    expect((claim.body as { status: string; sent_last_hour: number }).status).toBe("claimed");
    expect((claim.body as { sent_last_hour: number }).sent_last_hour).toBeGreaterThanOrEqual(2);
  });
});
