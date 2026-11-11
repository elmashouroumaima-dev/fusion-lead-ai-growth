import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, ORG, psql, select, type Persona } from "./harness";

/**
 * Envoi d'e-mail derrière la chaîne de contrôles, par la Data API (J31, spec §5.7 et §9.2) : l'approbation est HUMAINE (owner et admin
 * seulement, jamais service_role), elle met le job d'envoi en file, les fonctions du worker (tentative unique, résultats) sont réservées à
 * service_role, `suppressions` se lit par rôle sans écriture directe, aucune fuite entre entreprises. Ré-exécutable : données supprimées.
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const CIPHERTEXT = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=";
const NONCE = "QUJDREVGR0hJSktM";
const rpc = (persona: Persona, fn: string, args: Record<string, unknown>) => api<unknown>(persona, "POST", `rpc/${fn}`, args);
const message = (result: { body: unknown }): string =>
  typeof result.body === "object" && result.body !== null && "message" in result.body ? String((result.body as { message: unknown }).message) : "";

const cleanup = () =>
  psql(`
    set session_replication_role = replica;
    delete from public.jobs where kind = 'send_message' and payload ->> 'message_id' in (select id::text from public.messages where idempotency_key like 'sc${run}%');
    delete from public.suppressions where value_normalized like '%@sc${run}.test';
    delete from public.messages where idempotency_key like 'sc${run}%';
    delete from public.conversations where contact_id in (select id from public.contacts where email_normalized like '%@sc${run}.test');
    delete from public.channels where integration_id in (select id from public.integrations where external_account_id like 'rlssc${run}%');
    delete from private.secrets where id in (select secret_ref from public.integrations where external_account_id like 'rlssc${run}%');
    delete from public.integrations where external_account_id like 'rlssc${run}%';
    delete from public.contacts where email_normalized like '%@sc${run}.test';
  `);

let conversation = "";
const messages: Record<string, string> = {};

async function newMessage(key: string): Promise<string> {
  const result = await rpc("service", "message_record", {
    p_org: ORG.alpha, p_conversation: conversation, p_direction: "outbound", p_provider_message_id: null, p_body: `SECRET-CORPS-${run} ${key}`, p_idempotency_key: `sc${run}${key}`, p_event_at: null,
  });
  expect(result.status).toBe(200);
  return String((result.body as { message_id: string }).message_id);
}

beforeAll(async () => {
  cleanup();
  const integration = await rpc("shared", "create_provider_integration", { p_org: ORG.alpha, p_provider: "email", p_account: `rlssc${run}a`, p_scopes: [], p_secret_id: randomUUID(), p_ciphertext: CIPHERTEXT, p_nonce: NONCE, p_key_version: 1 });
  const channel = String((await rpc("shared", "create_channel", { p_org: ORG.alpha, p_integration: String(integration.body), p_type: "email", p_sender: `ventes@sc${run}.test`, p_scope: [] })).body);
  psql(`insert into public.contacts (organization_id, name, email_raw, email_normalized) values ('${ORG.alpha}', 'SC ${run}', 'a1@sc${run}.test', 'a1@sc${run}.test')`);
  const contact = psql(`select id from public.contacts where organization_id = '${ORG.alpha}' and email_normalized = 'a1@sc${run}.test'`);
  conversation = String(((await rpc("service", "conversation_get_or_create", { p_org: ORG.alpha, p_contact: contact, p_channel: channel })).body as { id: string }).id);
  for (const key of ["m1", "m2", "m3", "m4"]) messages[key] = await newMessage(key);
});
afterAll(cleanup);

describe("approbation : humaine, owner et admin seulement", () => {
  it("marketing, commercial, analyste, autre entreprise, sans adhésion, anonyme et service_role : refusés, rien ne change", async () => {
    for (const persona of ["alphaMarketing", "alphaSales", "alphaAnalyst", "betaOwner", "nobody", "anon", "service"] as const) {
      const denied = await rpc(persona, "message_approve", { p_org: ORG.alpha, p_message: messages.m1, p_purpose: "marketing" });
      expect([401, 403], persona).toContain(denied.status);
    }
    expect(psql(`select coalesce(approved_by::text, 'null') from public.messages where id = '${messages.m1}'`)).toBe("null");
    expect(psql(`select count(*) from public.jobs where kind = 'send_message' and payload ->> 'message_id' = '${messages.m1}'`)).toBe("0");
  });

  it("l'owner approuve : approbation tracée, finalité figée, UN job d'envoi dont la charge utile ne porte que l'identifiant", async () => {
    const ok = await rpc("shared", "message_approve", { p_org: ORG.alpha, p_message: messages.m1, p_purpose: "marketing" });
    expect(ok.status).toBe(204);
    expect(psql(`select approved_purpose || ':' || (approved_by is not null)::text || ':' || (approved_at is not null)::text from public.messages where id = '${messages.m1}'`)).toBe("marketing:true:true");
    expect(psql(`select payload::text from public.jobs where kind = 'send_message' and payload ->> 'message_id' = '${messages.m1}'`)).toBe(`{"message_id": "${messages.m1}"}`);
    const again = await rpc("shared", "message_approve", { p_org: ORG.alpha, p_message: messages.m1, p_purpose: "service" });
    expect(message(again)).toBe("message_not_approvable");
    expect(psql(`select count(*) from public.jobs where kind = 'send_message' and payload ->> 'message_id' = '${messages.m1}'`)).toBe("1");
    expect(psql(`select approved_purpose from public.messages where id = '${messages.m1}'`)).toBe("marketing");
  });

  it("l'admin approuve ; finalité mal formée et message inconnu : refusés", async () => {
    expect((await rpc("alphaAdmin", "message_approve", { p_org: ORG.alpha, p_message: messages.m2, p_purpose: "service" })).status).toBe(204);
    expect((await rpc("shared", "message_approve", { p_org: ORG.alpha, p_message: messages.m3, p_purpose: "Pas valide" })).status).toBe(400);
    expect(message(await rpc("shared", "message_approve", { p_org: ORG.alpha, p_message: randomUUID(), p_purpose: "marketing" }))).toBe("not_found");
    expect(psql(`select coalesce(approved_by::text, 'null') from public.messages where id = '${messages.m3}'`)).toBe("null");
  });

  it("l'owner d'une autre entreprise ne peut pas approuver ce message en se déclarant dans la sienne", async () => {
    const crossed = await rpc("betaOwner", "message_approve", { p_org: ORG.beta, p_message: messages.m3, p_purpose: "marketing" });
    expect(message(crossed)).toBe("not_found");
    expect(psql(`select coalesce(approved_by::text, 'null') from public.messages where id = '${messages.m3}'`)).toBe("null");
  });
});

describe("fonctions du worker : service_role seulement", () => {
  const claim = (persona: Persona, id: string) => rpc(persona, "message_send_claim", { p_org: ORG.alpha, p_message: id });

  it("owner, admin, commercial, Beta et anonyme ne peuvent ni réclamer, ni marquer, ni libérer", async () => {
    for (const persona of ["shared", "alphaAdmin", "alphaSales", "betaOwner", "nobody", "anon"] as const) {
      expect([401, 403], persona).toContain((await claim(persona, messages.m1 as string)).status);
      expect([401, 403], persona).toContain((await rpc(persona, "message_mark_accepted", { p_org: ORG.alpha, p_message: messages.m1, p_provider_message_id: "pm-x-1" })).status);
      expect([401, 403], persona).toContain((await rpc(persona, "message_mark_failed", { p_org: ORG.alpha, p_message: messages.m1, p_code: "x" })).status);
      expect([401, 403], persona).toContain((await rpc(persona, "message_release_claim", { p_org: ORG.alpha, p_message: messages.m1 })).status);
    }
    expect(psql(`select count(*) from public.messages where id = '${messages.m1}' and send_claimed_at is not null`)).toBe("0");
  });

  it("le service réclame UNE fois ; une autre entreprise ne voit rien ; accepted n'est pas delivered", async () => {
    const first = await claim("service", messages.m1 as string);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: "claimed", message: { approved: true, purpose: "marketing" }, consent: false, suppressed: false });
    expect((await claim("service", messages.m1 as string)).body).toEqual({ status: "in_progress" });
    const wrongOrg = await rpc("service", "message_send_claim", { p_org: ORG.beta, p_message: messages.m1 });
    expect(wrongOrg.body).toEqual({ status: "missing" });
    expect((await rpc("service", "message_mark_accepted", { p_org: ORG.alpha, p_message: messages.m1, p_provider_message_id: `pm-${run}-1` })).status).toBe(204);
    expect(psql(`select status || ':' || provider_message_id from public.messages where id = '${messages.m1}'`)).toBe(`accepted:pm-${run}-1`);
    expect((await rpc("service", "message_mark_accepted", { p_org: ORG.alpha, p_message: messages.m1, p_provider_message_id: `pm-${run}-2` })).status).not.toBe(204);
  });

  it("un message non approuvé ne peut pas passer à accepted, même par le worker", async () => {
    expect((await claim("service", messages.m4 as string)).body).toMatchObject({ status: "claimed", message: { approved: false } });
    const accepted = await rpc("service", "message_mark_accepted", { p_org: ORG.alpha, p_message: messages.m4, p_provider_message_id: `pm-${run}-4` });
    expect(accepted.status).not.toBe(204);
    expect(psql(`select status from public.messages where id = '${messages.m4}'`)).toBe("queued");
    expect((await rpc("service", "message_release_claim", { p_org: ORG.alpha, p_message: messages.m4 })).status).toBe(204);
    expect((await rpc("service", "message_mark_failed", { p_org: ORG.alpha, p_message: messages.m4, p_code: "refused_not_approved" })).status).toBe(204);
    expect(psql(`select status || ':' || error_code from public.messages where id = '${messages.m4}'`)).toBe("failed:refused_not_approved");
  });
});

describe("suppressions : lecture par rôle, aucune écriture", () => {
  beforeAll(() => {
    psql(`insert into public.suppressions (organization_id, channel, value_normalized, reason) values ('${ORG.alpha}', 'email', 'x1@sc${run}.test', 'bounce')`);
  });

  it("owner, admin et marketing lisent ; commercial, analyste, Beta, sans adhésion et anonyme : rien", async () => {
    for (const persona of ["shared", "alphaAdmin", "alphaMarketing"] as const) {
      const rows = await select<{ value_normalized: string }>(persona, `suppressions?value_normalized=like.*@sc${run}.test`);
      expect(rows.body.length, persona).toBe(1);
    }
    for (const persona of ["alphaSales", "alphaAnalyst", "betaOwner", "nobody"] as const) {
      const rows = await select<{ value_normalized: string }>(persona, `suppressions?value_normalized=like.*@sc${run}.test`);
      expect(rows.body.length, persona).toBe(0);
    }
    expect([401, 403]).toContain((await select("anon", "suppressions?limit=1")).status);
  });

  it("aucune écriture directe, même pour service_role", async () => {
    for (const persona of ["shared", "alphaAdmin", "alphaMarketing", "service"] as const) {
      const denied = await api<unknown>(persona, "POST", "suppressions", { organization_id: ORG.alpha, channel: "email", value_normalized: `x2@sc${run}.test`, reason: "manual" });
      expect([401, 403], persona).toContain(denied.status);
    }
    expect(psql(`select count(*) from public.suppressions where value_normalized = 'x2@sc${run}.test'`)).toBe("0");
  });
});

describe("aucune fuite dans l'audit", () => {
  it("ni corps de message, ni identifiant du fournisseur, ni clé d'envoi dans les événements message.*", () => {
    expect(
      psql(`select count(*) from public.audit_logs a where a.action like 'message.%' and a.entity_id in (select id from public.messages where idempotency_key like 'sc${run}%') and to_jsonb(a)::text ~* '(SECRET-CORPS|pm-${run}|sc${run})'`),
    ).toBe("0");
  });
});
