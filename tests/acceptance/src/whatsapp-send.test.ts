import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, ORG, psql, purgeIdempotencyKeys } from "../../../supabase/tests/rls/src/harness";
import { postJson, signIn, type Session } from "./app-client";

/**
 * Envoi WhatsApp conforme (J36, spec §9.3) par la VRAIE API : route de synchronisation des modèles (rôles, cloisonnement, validation : aucun appel à Meta ici),
 * puis le parcours « modèle approuvé → rattaché → approuvé par un humain → réclamation de l'envoi » par les fonctions réelles (PostgREST) : seuls owner et admin
 * rattachent un modèle ; le modèle d'un autre canal ou non approuvé est refusé ; hors fenêtre de 24 h la réclamation le dit.
 * Exige la clé maître (SECRETS_MASTER_KEY, la même que celle de l'application) : sans elle, le flux entier est ignoré.
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const stamp = String(Date.now()).slice(-9);
const PHONE_ID = `5${stamp}01`;
const KEY_PREFIX = `acc36${run}`;
const MASTER = process.env.SECRETS_MASTER_KEY;

const sessions = new Map<string, Session>();
const as = (who: string): Session => {
  const session = sessions.get(who);
  if (!session) throw new Error(`session absente : ${who}`);
  return session;
};
let counter = 0;
const post = (who: string | null, path: string, payload: unknown, org: string = ORG.alpha) =>
  postJson(who ? as(who) : null, path, payload, { activeOrg: org, headers: { "idempotency-key": `${KEY_PREFIX}-${(counter += 1)}-${randomUUID()}` } });
const rpc = <T = unknown>(persona: Parameters<typeof api>[0], fn: string, args: Record<string, unknown>) => api<T>(persona, "POST", `rpc/${fn}`, args);

let integration = "";
let channel = "";
let otherChannel = "";
let contact = "";
const message: Record<string, string> = {};
const template: Record<string, string> = {};

const cleanup = () => {
  psql(`
    begin;
    set local session_replication_role = replica;
    delete from public.jobs where payload ->> 'message_id' in (select id::text from public.messages where conversation_id in (select id from public.conversations where contact_id in (select id from public.contacts where email_normalized like '%@ws${run}.test')));
    delete from public.messages where conversation_id in (select id from public.conversations where contact_id in (select id from public.contacts where email_normalized like '%@ws${run}.test'));
    delete from public.conversations where contact_id in (select id from public.contacts where email_normalized like '%@ws${run}.test');
    delete from public.message_templates where channel_id in (select id from public.channels where integration_id in (select id from public.integrations where external_account_id = '${PHONE_ID}'));
    delete from public.channels where integration_id in (select id from public.integrations where external_account_id = '${PHONE_ID}');
    delete from private.secrets where id in (select secret_ref from public.integrations where external_account_id = '${PHONE_ID}');
    delete from public.integrations where external_account_id = '${PHONE_ID}';
    delete from public.consent_events where contact_id in (select id from public.contacts where email_normalized like '%@ws${run}.test');
    delete from public.contacts where email_normalized like '%@ws${run}.test';
    commit;
  `);
  purgeIdempotencyKeys(KEY_PREFIX);
};

beforeAll(async () => {
  cleanup();
  for (const name of ["shared", "alpha-admin", "alpha-marketing", "alpha-sales", "alpha-analyst", "beta-owner"]) sessions.set(name, await signIn(`${name}@seed.test`));
  if (!MASTER) return;
  expect((await post("shared", "/api/integrations", { provider: "whatsapp", external_account_id: PHONE_ID, scopes: [], secret: `EAAG-jeton-${run}-0123456789` })).status).toBe(201);
  integration = psql(`select id from public.integrations where external_account_id = '${PHONE_ID}'`);
  psql(`
    update public.integrations set status = 'active' where id = '${integration}';
    insert into public.channels (organization_id, type, integration_id, sender_identity, status) values
      ('${ORG.alpha}', 'whatsapp', '${integration}', '+15550780001', 'active'), ('${ORG.alpha}', 'whatsapp', '${integration}', '+15550780002', 'active');
    insert into public.contacts (organization_id, name, email_raw, email_normalized, phone_e164) values ('${ORG.alpha}', 'WS K1 ${run}', 'k1@ws${run}.test', 'k1@ws${run}.test', '+2125${stamp.slice(-8)}');
  `);
  channel = psql(`select id from public.channels where integration_id = '${integration}' and sender_identity = '+15550780001'`);
  otherChannel = psql(`select id from public.channels where integration_id = '${integration}' and sender_identity = '+15550780002'`);
  contact = psql(`select id from public.contacts where email_normalized = 'k1@ws${run}.test'`);
  const conv = String(((await rpc("service", "conversation_get_or_create", { p_org: ORG.alpha, p_contact: contact, p_channel: channel })).body as { id: string }).id);
  for (const key of ["m1", "m2", "m3"]) {
    const recorded = await rpc<{ message_id: string }>("service", "message_record", { p_org: ORG.alpha, p_conversation: conv, p_direction: "outbound", p_provider_message_id: null, p_body: `Offre ${key}`, p_idempotency_key: `acc36-${run}-${key}`, p_event_at: null });
    message[key] = recorded.body.message_id;
  }
  const items = (name: string, status: string) => [{ name, language: "fr", category: "marketing", status, components: [{ type: "BODY", text: "Bonjour {{1}}" }] }];
  expect((await rpc("service", "message_templates_sync", { p_org: ORG.alpha, p_channel: channel, p_items: items("offre_ete", "approved") })).status).toBe(200);
  expect((await rpc("service", "message_templates_sync", { p_org: ORG.alpha, p_channel: channel, p_items: items("en_attente", "pending") })).status).toBe(200);
  expect((await rpc("service", "message_templates_sync", { p_org: ORG.alpha, p_channel: otherChannel, p_items: items("autre_canal", "approved") })).status).toBe(200);
  for (const name of ["offre_ete", "en_attente", "autre_canal"]) template[name] = psql(`select id from public.message_templates where name = '${name}' and organization_id = '${ORG.alpha}' order by version desc limit 1`);
});
afterAll(cleanup);

describe.skipIf(!MASTER)("synchronisation des modèles (route, sans appel à Meta)", () => {
  const body = () => ({ integration_id: integration, channel_id: channel, waba_id: "102290129340398" });
  it("commercial, marketing, analyste : 403 ; anonyme : 401 ; sans clé d'idempotence, organization_id ou waba_id invalide : 400", async () => {
    for (const who of ["alpha-sales", "alpha-marketing", "alpha-analyst"]) expect((await post(who, "/api/integrations/templates/sync", body())).status, who).toBe(403);
    expect((await post(null, "/api/integrations/templates/sync", body())).status).toBe(401);
    expect((await post("shared", "/api/integrations/templates/sync", { ...body(), organization_id: ORG.beta })).status).toBe(400);
    expect((await post("shared", "/api/integrations/templates/sync", { ...body(), waba_id: "../x" })).status).toBe(400);
    expect((await postJson(as("shared"), "/api/integrations/templates/sync", body(), { activeOrg: ORG.alpha })).status).toBe(400);
  });
  it("l'owner d'une autre entreprise ne peut pas viser cette intégration : 404", async () => {
    expect((await post("beta-owner", "/api/integrations/templates/sync", body(), ORG.beta)).status).toBe(404);
  });
  it("un utilisateur ne peut pas écrire les modèles par la fonction SQL ni directement", async () => {
    const denied = await rpc("alphaAdmin", "message_templates_sync", { p_org: ORG.alpha, p_channel: channel, p_items: [] });
    expect([401, 403]).toContain(denied.status);
    const direct = await api("shared", "POST", "message_templates", { organization_id: ORG.alpha, channel_id: channel, name: "x", language: "fr", category: "marketing", status: "approved" });
    expect([401, 403]).toContain(direct.status);
  });
});

describe.skipIf(!MASTER)("parcours modèle → approbation → réclamation (fonctions réelles)", () => {
  it("lecture des modèles : owner et marketing oui, commercial non", async () => {
    expect(((await api("shared", "GET", `message_templates?channel_id=eq.${channel}&select=name,version,status`)).body as unknown[]).length).toBeGreaterThanOrEqual(2);
    expect(((await api("alphaMarketing", "GET", `message_templates?channel_id=eq.${channel}&select=name`)).body as unknown[]).length).toBeGreaterThanOrEqual(2);
    expect((await api("alphaSales", "GET", `message_templates?channel_id=eq.${channel}&select=name`)).body as unknown[]).toEqual([]);
  });

  it("rattachement : commercial et marketing refusés, modèle d'un autre canal ou non approuvé refusé, owner accepté", async () => {
    const attach = (who: Parameters<typeof api>[0], tpl: string, vars: unknown = ["Nadia"]) => rpc(who, "message_attach_template", { p_org: ORG.alpha, p_message: message.m1, p_template: tpl, p_variables: vars });
    expect([401, 403]).toContain((await attach("alphaSales", template.offre_ete as string)).status);
    expect((await attach("shared", template.autre_canal as string)).status).toBeGreaterThanOrEqual(400);
    expect((await attach("shared", template.en_attente as string)).status).toBeGreaterThanOrEqual(400);
    expect((await attach("shared", template.offre_ete as string, [1])).status).toBeGreaterThanOrEqual(400);
    expect((await attach("shared", template.offre_ete as string)).status).toBeLessThan(300);
    expect(psql(`select template_id from public.messages where id = '${message.m1}'`)).toBe(template.offre_ete);
  });

  it("approbation par un humain puis réclamation : numéro du contact, fenêtre fermée, modèle avec nom, langue, version et variables", async () => {
    const approve = await rpc("shared", "message_approve", { p_org: ORG.alpha, p_message: message.m1, p_purpose: "marketing" });
    expect(approve.status).toBeLessThan(300);
    const claim = await rpc<Record<string, unknown>>("service", "message_send_claim", { p_org: ORG.alpha, p_message: message.m1 });
    expect(claim.body).toMatchObject({
      status: "claimed",
      window_open: false,
      contact: { phone: expect.stringMatching(/^\+2125/) },
      channel: { type: "whatsapp", account: PHONE_ID },
      template: { name: "offre_ete", language: "fr", version: 1, status: "approved", variables: ["Nadia"] },
    });
    expect(psql(`select approved_recipient from public.messages where id = '${message.m1}'`)).toMatch(/^\+2125/);
  });

  it("le modèle et les variables ne changent plus après l'approbation (rattacher de nouveau : refusé)", async () => {
    const again = await rpc("shared", "message_attach_template", { p_org: ORG.alpha, p_message: message.m1, p_template: template.offre_ete, p_variables: ["Autre"] });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(psql(`select template_variables::text from public.messages where id = '${message.m1}'`)).toBe('["Nadia"]');
  });

  it("message sans modèle : réclamation avec fenêtre fermée et sans modèle (le contrôle final du worker refusera : template_missing)", async () => {
    expect((await rpc("shared", "message_approve", { p_org: ORG.alpha, p_message: message.m2, p_purpose: "marketing" })).status).toBeLessThan(300);
    const claim = await rpc<Record<string, unknown>>("service", "message_send_claim", { p_org: ORG.alpha, p_message: message.m2 });
    expect(claim.body).toMatchObject({ status: "claimed", window_open: false, template: null });
  });

  it("fenêtre ouverte par un message reçu il y a moins de 24 h", async () => {
    const conv = psql(`select conversation_id from public.messages where id = '${message.m3}'`);
    await rpc("service", "message_record", { p_org: ORG.alpha, p_conversation: conv, p_direction: "inbound", p_provider_message_id: `wamid.WS-${run}`, p_body: "Bonjour", p_idempotency_key: null, p_event_at: new Date(Date.now() - 3_600_000).toISOString() });
    expect((await rpc("shared", "message_approve", { p_org: ORG.alpha, p_message: message.m3, p_purpose: "marketing" })).status).toBeLessThan(300);
    const claim = await rpc<Record<string, unknown>>("service", "message_send_claim", { p_org: ORG.alpha, p_message: message.m3 });
    expect(claim.body).toMatchObject({ status: "claimed", window_open: true });
  });
});
