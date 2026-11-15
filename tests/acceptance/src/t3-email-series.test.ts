import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKeyRing, sealOrganizationSecret } from "../../../packages/adapters/src/secrets";
import { createUnsubscribeToken } from "../../../packages/adapters/src/email/unsubscribe";
import { api, ORG, psql } from "../../../supabase/tests/rls/src/harness";
import { BASE_URL } from "./app-client";
import { createSendWorker, drain, holdBack, providerMock, release, step } from "./channels.testkit";

/**
 * T3 (spec §13 critère 5 et scénario « campagne e-mail mini vers une liste consentante, puis désabonnement en cours ») : série de 5 e-mails
 * vers 5 contacts consentants, désabonnement du 3e PENDANT la série par le VRAI lien (route publique), puis panne du fournisseur (503 deux fois,
 * puis 200). Le VRAI worker (Runner, handler `send_message`, base) tourne contre un Postmark simulé (`fetch` injecté dans l'adaptateur réel).
 * Vérifié : compteurs, statuts, un seul envoi par destinataire, le désabonné ne reçoit rien, chaque e-mail porte son lien de désabonnement,
 * ni jeton ni corps dans l'audit. Exige la clé maître (SECRETS_MASTER_KEY, celle de l'application, pour les jetons de désabonnement).
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const MASTER = process.env.SECRETS_MASTER_KEY;
const VERSION = Number(process.env.SECRETS_KEY_VERSION ?? "1");
const keyRing = MASTER ? createKeyRing(VERSION, { [VERSION]: MASTER }) : null;
const DOMAIN = `t3${run}.test`;
const ACCOUNT = `rlst3${run}`;
const SEND_TOKEN = `pm-token-${run}-0123456789abcdef`;
const BODY_MARK = `CORPS-SECRET-T3-${run}`;
const KEYS = ["k1", "k2", "k3", "k4", "k5", "k6"] as const;

const rpc = <T = unknown>(persona: "service" | "shared", fn: string, args: Record<string, unknown>) => api<T>(persona, "POST", `rpc/${fn}`, args);
const first = (sql: string): string => psql(sql).trim().split("\n").filter((l) => l.length > 0)[0] ?? "";
const addr = (key: string) => `${key}@${DOMAIN}`;
const contact: Record<string, string> = {};
const earlier: Record<string, string> = {};
const series: Record<string, string> = {};
let channel = "";
let integration = "";

const status = (id: string) => first(`select status from public.messages where id = '${id}'`);
const failure = (id: string) => first(`select coalesce(error_code, '') from public.messages where id = '${id}'`);
const jobStatus = (id: string) => first(`select status from public.jobs where kind = 'send_message' and payload ->> 'message_id' = '${id}'`);
const oneClick = (token: string) =>
  fetch(`${BASE_URL}/api/unsubscribe/${token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.40" }, body: "List-Unsubscribe=One-Click" });

async function newOutbound(key: string, label: string): Promise<string> {
  const conv = first(`select id from public.conversations where contact_id = '${contact[key]}'`);
  const recorded = await rpc<{ message_id: string }>("service", "message_record", {
    p_org: ORG.alpha, p_conversation: conv, p_direction: "outbound", p_provider_message_id: null, p_body: `${BODY_MARK} ${key} ${label}`, p_idempotency_key: `t3${run}${key}${label}`, p_event_at: null,
  });
  expect(recorded.status).toBe(200);
  return recorded.body.message_id;
}

const cleanup = () => {
  psql(`
    begin;
    set local session_replication_role = replica;
    delete from public.jobs where payload ->> 'message_id' in (select id::text from public.messages where idempotency_key like 't3${run}%');
    delete from public.suppressions where value_normalized like '%@${DOMAIN}';
    delete from public.consent_events where contact_id in (select id from public.contacts where email_normalized like '%@${DOMAIN}');
    delete from public.audit_logs where organization_id = '${ORG.alpha}' and after::text like '%${DOMAIN}%';
    delete from public.messages where conversation_id in (select id from public.conversations where contact_id in (select id from public.contacts where email_normalized like '%@${DOMAIN}'));
    delete from public.conversations where contact_id in (select id from public.contacts where email_normalized like '%@${DOMAIN}');
    delete from public.channels where sender_identity like '%@${DOMAIN}';
    delete from private.secrets where id in (select secret_ref from public.integrations where external_account_id = '${ACCOUNT}');
    delete from public.integrations where external_account_id = '${ACCOUNT}';
    delete from public.contacts where email_normalized like '%@${DOMAIN}';
    commit;
  `);
};

beforeAll(async () => {
  cleanup();
  if (!keyRing) return;
  // la file ne contient que les jobs de CE test (le worker de test réclame tout ce qui est échu)
  psql(`delete from public.jobs where kind = 'send_message' and status in ('queued', 'running')`);
  const sealed = sealOrganizationSecret({ organizationId: ORG.alpha, plaintext: SEND_TOKEN, keyRing });
  const created = await rpc<string>("shared", "create_provider_integration", {
    p_org: ORG.alpha, p_provider: "email", p_account: ACCOUNT, p_scopes: [], p_secret_id: sealed.secretId, p_ciphertext: sealed.ciphertext, p_nonce: sealed.nonce, p_key_version: sealed.keyVersion,
  });
  expect(created.status).toBe(200);
  integration = String(created.body);
  psql(`update public.integrations set status = 'active' where id = '${integration}'`);
  channel = String((await rpc("shared", "create_channel", { p_org: ORG.alpha, p_integration: integration, p_type: "email", p_sender: `ventes@${DOMAIN}`, p_scope: [] })).body);
  psql(`update public.channels set status = 'active' where id = '${channel}'`);
  for (const key of KEYS) {
    psql(`insert into public.contacts (organization_id, name, email_raw, email_normalized) values ('${ORG.alpha}', 'T3 ${key} ${run}', '${addr(key)}', '${addr(key)}')`);
    contact[key] = first(`select id from public.contacts where organization_id = '${ORG.alpha}' and email_normalized = '${addr(key)}'`);
    psql(`insert into public.consent_events (organization_id, contact_id, channel, purpose, source) values ('${ORG.alpha}', '${contact[key]}', 'email', 'marketing', 'form')`);
    await rpc("service", "conversation_get_or_create", { p_org: ORG.alpha, p_contact: contact[key], p_channel: channel });
    // un e-mail DÉJÀ envoyé à chaque contact : c'est de lui que vient son lien de désabonnement
    earlier[key] = await newOutbound(key, "avant");
    psql(`update public.messages set approved_by = (select id from auth.users where email = 'shared@seed.test'), approved_at = now(), approved_purpose = 'marketing', approved_recipient = '${addr(key)}',
      status = 'accepted', provider_message_id = 'pm-${run}-${key}', send_claimed_at = now(), sent_at = now() - interval '2 days' where id = '${earlier[key]}'`);
  }
});
afterAll(cleanup);

const tokenFor = (key: string) => createUnsubscribeToken(keyRing as NonNullable<typeof keyRing>, { organizationId: ORG.alpha, messageId: earlier[key] as string });

describe.skipIf(!keyRing)("T3 : série d'e-mails et désabonnement en cours", () => {
  const provider = providerMock({ [addr("k6")]: [{ status: 503 }, { status: 503 }] });
  let worker: ReturnType<typeof createSendWorker>;

  beforeAll(async () => {
    worker = createSendWorker({ masterKey: MASTER as string, version: VERSION, provider: provider.fetch });
    // la série : 5 e-mails (k1 à k5) approuvés par un humain habilité (owner) : chacun met UN job d'envoi en file
    for (const key of ["k1", "k2", "k3", "k4", "k5"]) {
      series[key] = await newOutbound(key, "serie");
      const approved = await rpc("shared", "message_approve", { p_org: ORG.alpha, p_message: series[key], p_purpose: "marketing" });
      expect(approved.status, key).toBe(204);
    }
  });

  it("avant l'envoi : 5 messages « queued », 5 jobs, rien n'a quitté la plateforme", () => {
    for (const key of ["k1", "k2", "k3", "k4", "k5"]) {
      expect(status(series[key] as string), key).toBe("queued");
      expect(jobStatus(series[key] as string), key).toBe("queued");
    }
    expect(provider.calls).toHaveLength(0);
  });

  it("la série démarre : k1 et k2 sont envoyés ; k3, k4, k5 attendent", async () => {
    holdBack(["k3", "k4", "k5"].map((k) => series[k] as string));
    expect(await drain(worker)).toBe(2);
    expect(provider.calls.map((c) => c.to)).toEqual([addr("k1"), addr("k2")]);
    expect(status(series.k1 as string)).toBe("accepted");
    expect(status(series.k2 as string)).toBe("accepted");
    expect(first(`select count(*) from public.messages where id in ('${series.k1}', '${series.k2}') and provider_message_id is not null and sent_at is not null`)).toBe("2");
  });

  it("chaque e-mail envoyé porte son lien de désabonnement signé (en-tête One-Click et pied de message)", () => {
    for (const call of provider.calls) {
      const headers = (call.body.Headers as Array<{ Name: string; Value: string }>) ?? [];
      expect(headers.map((h) => h.Name)).toEqual(expect.arrayContaining(["List-Unsubscribe", "List-Unsubscribe-Post"]));
      expect(String(call.body.TextBody)).toContain("/unsubscribe/");
      expect(call.body.From).toBe(`ventes@${DOMAIN}`);
    }
  });

  it("EN COURS DE SÉRIE, k3 se désabonne par le lien : consentement révoqué, adresse supprimée, son envoi et son job annulés", async () => {
    const res = await oneClick(tokenFor("k3"));
    expect(res.status).toBe(200);
    expect(first(`select count(*) from public.suppressions where organization_id = '${ORG.alpha}' and value_normalized = '${addr("k3")}'`)).toBe("1");
    expect(first(`select count(*) from public.consent_events where contact_id = '${contact.k3}' and channel = 'email' and revoked_at is null`)).toBe("0");
    expect(status(series.k3 as string)).toBe("cancelled");
    expect(jobStatus(series.k3 as string)).toBe("cancelled");
    // les autres contacts sont intacts
    for (const key of ["k4", "k5"]) {
      expect(status(series[key] as string), key).toBe("queued");
      expect(first(`select count(*) from public.consent_events where contact_id = '${contact[key]}' and revoked_at is null`), key).toBe("1");
    }
  });

  it("la série reprend : k4 et k5 sont envoyés, k3 ne reçoit RIEN ; compteurs : 4 acceptés, 1 annulé, 4 appels, un seul par destinataire", async () => {
    release(["k4", "k5"].map((k) => series[k] as string));
    expect(await drain(worker)).toBe(2);
    expect(status(series.k4 as string)).toBe("accepted");
    expect(status(series.k5 as string)).toBe("accepted");
    // k4 et k5 sont rendus échus par la même instruction : leur ordre de prise n'est pas garanti (tri par identifiant)
    expect(provider.calls.map((c) => c.to).sort()).toEqual([addr("k1"), addr("k2"), addr("k4"), addr("k5")].sort());
    expect(provider.toRecipient(addr("k3"))).toHaveLength(0);
    const counts = psql(`select status || ':' || count(*) from public.messages where id in (${["k1", "k2", "k3", "k4", "k5"].map((k) => `'${series[k]}'`).join(",")}) group by status order by status`).trim().split("\n");
    expect(counts).toEqual(["accepted:4", "cancelled:1"]);
    expect(first(`select count(distinct provider_message_id) from public.messages where id in (${["k1", "k2", "k4", "k5"].map((k) => `'${series[k]}'`).join(",")})`)).toBe("4");
    expect(first(`select count(*) from public.jobs where kind = 'send_message' and status = 'succeeded' and payload ->> 'message_id' in (${["k1", "k2", "k4", "k5"].map((k) => `'${series[k]}'`).join(",")})`)).toBe("4");
  });

  it("un message ultérieur pour k3 (déjà désabonné) est refusé au contrôle final : message en échec « refused_… », le fournisseur n'est PAS appelé", async () => {
    const late = await newOutbound("k3", "tardif");
    expect((await rpc("shared", "message_approve", { p_org: ORG.alpha, p_message: late, p_purpose: "marketing" })).status).toBe(204);
    const before = provider.calls.length;
    expect(await drain(worker)).toBe(1);
    expect(provider.calls).toHaveLength(before);
    expect(status(late)).toBe("failed");
    expect(failure(late)).toMatch(/^refused_/);
  });

  it("panne du fournisseur : 503, 503 puis 200 pour k6 ; AUCUN doublon (3 appels, 1 message accepté, 1 identifiant fournisseur, 1 job réussi)", async () => {
    const message = await newOutbound("k6", "panne");
    expect((await rpc("shared", "message_approve", { p_org: ORG.alpha, p_message: message, p_purpose: "marketing" })).status).toBe(204);
    // 1re tentative : 503 -> message toujours « queued » (tentative libérée), job rejoué plus tard avec recul
    expect(await step(worker)).toBe(1);
    expect(provider.toRecipient(addr("k6"))).toHaveLength(1);
    expect(status(message)).toBe("queued");
    expect(jobStatus(message)).toBe("queued");
    expect(first(`select attempts from public.jobs where kind = 'send_message' and payload ->> 'message_id' = '${message}'`)).toBe("1");
    expect(await step(worker)).toBe(0); // le recul n'est pas écoulé : rien ne part
    // 2e tentative : 503 de nouveau
    release([message]);
    expect(await step(worker)).toBe(1);
    expect(provider.toRecipient(addr("k6"))).toHaveLength(2);
    expect(status(message)).toBe("queued");
    // 3e tentative : 200
    release([message]);
    expect(await step(worker)).toBe(1);
    expect(provider.toRecipient(addr("k6"))).toHaveLength(3);
    expect(status(message)).toBe("accepted");
    expect(jobStatus(message)).toBe("succeeded");
    expect(first(`select attempts from public.jobs where kind = 'send_message' and payload ->> 'message_id' = '${message}'`)).toBe("3");
    expect(first(`select count(*) from public.messages where conversation_id = (select id from public.conversations where contact_id = '${contact.k6}') and direction = 'outbound' and status = 'accepted' and provider_message_id is not null and id <> '${earlier.k6}'`)).toBe("1");
    // rejouer le job réussi n'envoie rien de plus
    release([message]);
    expect(await step(worker)).toBe(0);
    expect(provider.toRecipient(addr("k6"))).toHaveLength(3);
  });

  it("aucun corps de message ni jeton d'envoi dans l'audit ni dans les erreurs de jobs", () => {
    expect(first(`select count(*) from public.audit_logs where organization_id = '${ORG.alpha}' and (before::text like '%${BODY_MARK}%' or after::text like '%${BODY_MARK}%' or after::text like '%${SEND_TOKEN}%')`)).toBe("0");
    expect(first(`select count(*) from public.jobs where kind = 'send_message' and (coalesce(last_error, '') like '%${BODY_MARK}%' or payload::text like '%${BODY_MARK}%')`)).toBe("0");
    for (const call of provider.calls) expect(JSON.stringify(call.headers)).not.toContain(SEND_TOKEN);
  });
});

