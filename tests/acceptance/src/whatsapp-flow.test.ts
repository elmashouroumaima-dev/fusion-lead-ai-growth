import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProcessWebhookHandler } from "../../../apps/worker/src/handlers";
import { createWhatsAppWebhookProcessor, type WhatsAppEventGateway } from "../../../apps/worker/src/whatsapp-webhook";
import type { WebhookGateway } from "../../../apps/worker/src/webhooks";
import { api, ORG, psql, purgeIdempotencyKeys } from "../../../supabase/tests/rls/src/harness";
import { BASE_URL, postJson, signIn, type Session } from "./app-client";

/**
 * Réception WhatsApp (J35, spec §9.3) de bout en bout : la VRAIE route `/api/webhooks/whatsapp` (signature), les VRAIES fonctions SQL et le VRAI handler
 * `process_webhook` du worker avec le processeur WhatsApp. Scénarios : message reçu rattaché au contact par son numéro, statut de NOTRE message appliqué,
 * rejeu de la requête (route : doublon) et retraitement (aucun second message), requête qui se recoupe avec une autre (un message de plus seulement,
 * déduplication par identifiant Meta), statut hors ordre, expéditeur inconnu (file de tri, AUCUN contact créé), forme conservée minimale (ni profil ni média).
 * Exige la clé maître (SECRETS_MASTER_KEY, la même que celle de l'application) : sans elle, le flux entier est ignoré.
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const stamp = String(Date.now()).slice(-9);
const PHONE = `6${stamp}01`;
const KEY_PREFIX = `acc35${run}`;
const APP_SECRET = `app-secret-${run}-0123456789abcdef0123`;
const TOKEN = `EAAG-jeton-${run}-0123456789`;
const CONTACT_PHONE = `+2126${stamp.slice(-8)}`;
const UNKNOWN_PHONE = `+2127${stamp.slice(-8)}`;
const MASTER = process.env.SECRETS_MASTER_KEY;
const IP = "203.0.113.35";

const sessions = new Map<string, Session>();
const as = (who: string): Session => {
  const session = sessions.get(who);
  if (!session) throw new Error(`session absente : ${who}`);
  return session;
};
let counter = 0;
const post = (who: string, path: string, payload: unknown) =>
  postJson(as(who), path, payload, { activeOrg: ORG.alpha, headers: { "idempotency-key": `${KEY_PREFIX}-${(counter += 1)}-${randomUUID()}` } });

const wrap = (value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "102290129340398", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550783881", phone_number_id: PHONE }, ...value } }] }],
});
const message = (id: string, from: string, text: string) => ({ from: from.slice(1), id, timestamp: "1700000000", text: { body: text }, type: "text" });
const status = (id: string, s: string) => ({ id, status: s, timestamp: "1700000100", recipient_id: CONTACT_PHONE.slice(1) });
const sign = (raw: string) => `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;
const hook = (value: unknown) => {
  const raw = JSON.stringify(value);
  return fetch(`${BASE_URL}/api/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": IP, "x-hub-signature-256": sign(raw) }, body: raw });
};

const rpc = <T = unknown>(fn: string, args: Record<string, unknown>) => api<T>("service", "POST", `rpc/${fn}`, args);
const webhookGateway: WebhookGateway = {
  async start(org, event) {
    const result = await rpc<{ status: string; provider?: string; integration_id?: string; payload?: unknown }>("webhook_start", { p_org: org, p_event: event });
    const body = result.body;
    if (body.status !== "running") return { status: body.status as "missing" | "done" };
    return { status: "running", provider: String(body.provider), integrationId: String(body.integration_id), payload: body.payload };
  },
  async finish(org, event, status, failureCode) {
    const result = await rpc("webhook_finish", { p_org: org, p_event: event, p_status: status, p_failure: failureCode });
    if (result.status >= 300) throw new Error("webhook_finish_failed");
  },
};
/** Passerelle du worker pour l'acceptation : les fonctions SQL réelles (service_role), mêmes arguments que la passerelle de production. */
const whatsappGateway: WhatsAppEventGateway = {
  async applyMessage(org, integrationId, event) {
    const result = await rpc<{ outcome: "recorded" | "duplicate" | "unmatched" | "dropped"; reason?: string }>("whatsapp_inbound_apply", {
      p_org: org, p_integration: integrationId, p_provider_message_id: event.id, p_from: event.from, p_type: event.type, p_body: event.text, p_received_at: event.at,
    });
    if (result.status !== 200) throw new Error(`whatsapp_inbound_${result.status}`);
    return result.body;
  },
  async applyStatus(org, integrationId, event) {
    const result = await rpc<{ outcome: "applied" | "ignored"; reason?: string }>("whatsapp_status_apply", {
      p_org: org, p_integration: integrationId, p_provider_message_id: event.id, p_status: event.status, p_error_code: event.errorCode, p_event_at: event.at,
    });
    if (result.status !== 200) throw new Error(`whatsapp_status_${result.status}`);
    return result.body;
  },
};
const handler = createProcessWebhookHandler(webhookGateway, new Map([["whatsapp", createWhatsAppWebhookProcessor(whatsappGateway)]]));
const processEvents = async (): Promise<void> => {
  const ids = psql(`select id from public.webhook_events where integration_id = '${integration}' and status = 'received' order by received_at`).split("\n").filter(Boolean);
  for (const eventId of ids) {
    await handler.run({ jobId: randomUUID(), organizationId: ORG.alpha, idempotencyKey: `process_webhook:${eventId}`, attempt: 1, maxAttempts: 5, signal: new AbortController().signal }, { event_id: eventId });
  }
};

let integration = "";
let channel = "";
let contact = "";
const inbound = () => Number(psql(`select count(*) from public.messages where direction = 'inbound' and conversation_id in (select id from public.conversations where contact_id = '${contact}')`));
const outboundStatus = () => psql(`select status from public.messages where provider_message_id = 'wamid.OUT-${run}'`);

const cleanup = () => {
  psql(`
    begin;
    set local session_replication_role = replica;
    delete from public.inbound_unmatched where integration_id in (select id from public.integrations where external_account_id = '${PHONE}');
    delete from public.webhook_events where integration_id in (select id from public.integrations where external_account_id = '${PHONE}');
    delete from public.suppressions where value_normalized in ('${CONTACT_PHONE}', '${UNKNOWN_PHONE}');
    delete from public.consent_events where contact_id in (select id from public.contacts where email_normalized like '%@wf${run}.test');
    delete from public.messages where conversation_id in (select id from public.conversations where contact_id in (select id from public.contacts where email_normalized like '%@wf${run}.test'));
    delete from public.conversations where contact_id in (select id from public.contacts where email_normalized like '%@wf${run}.test');
    delete from public.channels where integration_id in (select id from public.integrations where external_account_id = '${PHONE}');
    delete from private.secrets where id in (select secret_ref from public.integrations where external_account_id = '${PHONE}')
      or id in (select webhook_secret_ref from public.integrations where external_account_id = '${PHONE}');
    delete from public.integrations where external_account_id = '${PHONE}';
    delete from public.contacts where email_normalized like '%@wf${run}.test' or phone_e164 in ('${CONTACT_PHONE}', '${UNKNOWN_PHONE}');
    commit;
  `);
  purgeIdempotencyKeys(KEY_PREFIX);
};

beforeAll(async () => {
  cleanup();
  sessions.set("shared", await signIn("shared@seed.test"));
  if (!MASTER) return;
  expect((await post("shared", "/api/integrations", { provider: "whatsapp", external_account_id: PHONE, scopes: [], secret: TOKEN })).status).toBe(201);
  integration = psql(`select id from public.integrations where external_account_id = '${PHONE}'`);
  expect((await post("shared", "/api/integrations/webhook-secret", { integration_id: integration, secret: APP_SECRET })).status).toBe(200);
  psql(`
    update public.integrations set status = 'active' where id = '${integration}';
    insert into public.channels (organization_id, type, integration_id, sender_identity, status) values ('${ORG.alpha}', 'whatsapp', '${integration}', '+15550783881', 'active');
    insert into public.contacts (organization_id, name, email_raw, email_normalized, phone_e164) values ('${ORG.alpha}', 'WF K1 ${run}', 'k1@wf${run}.test', 'k1@wf${run}.test', '${CONTACT_PHONE}');
  `);
  channel = psql(`select id from public.channels where integration_id = '${integration}'`);
  contact = psql(`select id from public.contacts where email_normalized = 'k1@wf${run}.test'`);
  const conv = String(((await rpc("conversation_get_or_create", { p_org: ORG.alpha, p_contact: contact, p_channel: channel })).body as { id: string }).id);
  const recorded = await rpc<{ message_id: string }>("message_record", { p_org: ORG.alpha, p_conversation: conv, p_direction: "outbound", p_provider_message_id: null, p_body: "Notre offre", p_idempotency_key: `acc35-${run}-out`, p_event_at: null });
  psql(`update public.messages set approved_by = (select id from auth.users where email = 'shared@seed.test'), approved_at = now(), approved_purpose = 'marketing', approved_recipient = 'k1@wf${run}.test',
    status = 'accepted', provider_message_id = 'wamid.OUT-${run}', send_claimed_at = now(), sent_at = now() where id = '${recorded.body.message_id}'`);
});
afterAll(cleanup);

describe.skipIf(!MASTER)("réception WhatsApp", () => {
  it("message reçu + statut de notre message : acceptés par la route (200) puis appliqués par le worker ; le message est dans le fil du contact", async () => {
    const res = await hook(wrap({ contacts: [{ profile: { name: `Profil Secret ${run}` }, wa_id: CONTACT_PHONE.slice(1) }], messages: [message(`wamid.IN-${run}-1`, CONTACT_PHONE, `Bonjour ${run}`)], statuses: [status(`wamid.OUT-${run}`, "delivered")] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "accepted" });
    await processEvents();
    expect(inbound()).toBe(1);
    expect(psql(`select body from public.messages where provider_message_id = 'wamid.IN-${run}-1'`)).toBe(`Bonjour ${run}`);
    expect(outboundStatus()).toBe("delivered");
  });

  it("la forme conservée est minimale : ni profil du contact, ni objet brut de Meta", () => {
    const stored = psql(`select payload::text from public.webhook_events where integration_id = '${integration}' and status <> 'rejected' order by received_at limit 1`);
    expect(stored).not.toContain("Profil Secret");
    expect(stored).not.toContain("display_phone_number");
    expect(stored).toContain(`wamid.IN-${run}-1`);
  });

  it("rejeu de la même requête : 200 doublon (route) ; retraitement de l'événement : aucun second message", async () => {
    const body = wrap({ contacts: [{ profile: { name: `Profil Secret ${run}` }, wa_id: CONTACT_PHONE.slice(1) }], messages: [message(`wamid.IN-${run}-1`, CONTACT_PHONE, `Bonjour ${run}`)], statuses: [status(`wamid.OUT-${run}`, "delivered")] });
    const again = await hook(body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "duplicate" });
    // même sans la déduplication de la route : retraiter le contenu ne crée pas un second message
    psql(`update public.webhook_events set status = 'received', processed_at = null where integration_id = '${integration}' and status = 'processed'`);
    await processEvents();
    expect(inbound()).toBe(1);
  });

  it("une requête qui se recoupe avec la précédente (même message + un nouveau) : un seul message de plus (déduplication par identifiant Meta)", async () => {
    const res = await hook(wrap({ messages: [message(`wamid.IN-${run}-1`, CONTACT_PHONE, `Bonjour ${run}`), message(`wamid.IN-${run}-2`, CONTACT_PHONE, "Un second message")] }));
    expect(await res.json()).toEqual({ status: "accepted" });
    await processEvents();
    expect(inbound()).toBe(2);
  });

  it("statuts hors ordre : « read » puis « delivered » tardif : le message reste « read »", async () => {
    expect((await hook(wrap({ statuses: [status(`wamid.OUT-${run}`, "read")] }))).status).toBe(200);
    await processEvents();
    expect(outboundStatus()).toBe("read");
    expect((await hook(wrap({ statuses: [{ ...status(`wamid.OUT-${run}`, "delivered"), timestamp: "1700000200" }] }))).status).toBe(200);
    await processEvents();
    expect(outboundStatus()).toBe("read");
  });

  it("expéditeur inconnu : message rangé dans la file de tri, AUCUN contact créé", async () => {
    expect((await hook(wrap({ messages: [message(`wamid.IN-${run}-3`, UNKNOWN_PHONE, "Qui êtes-vous")] }))).status).toBe(200);
    await processEvents();
    expect(Number(psql(`select count(*) from public.contacts where phone_e164 = '${UNKNOWN_PHONE}'`))).toBe(0);
    expect(Number(psql(`select count(*) from public.inbound_unmatched where integration_id = '${integration}' and provider_message_id = 'wamid.IN-${run}-3' and reason = 'unknown_sender'`))).toBe(1);
    expect(inbound()).toBe(2);
  });

  it("un mot d'arrêt (STOP) d'un contact connu : consentement WhatsApp révoqué, numéro supprimé, envoi en file annulé ; une phrase qui contient « stop » ne retire rien", async () => {
    psql(`insert into public.consent_events (organization_id, contact_id, channel, purpose, source) values ('${ORG.alpha}', '${contact}', 'whatsapp', 'marketing', 'form')`);
    const conv = psql(`select id from public.conversations where contact_id = '${contact}'`);
    const queued = (await rpc<{ message_id: string }>("message_record", { p_org: ORG.alpha, p_conversation: conv, p_direction: "outbound", p_provider_message_id: null, p_body: "Offre à annuler", p_idempotency_key: `acc35-${run}-queued`, p_event_at: null })).body.message_id;
    const active = () => Number(psql(`select count(*) from public.consent_events where contact_id = '${contact}' and channel = 'whatsapp' and revoked_at is null`));
    expect((await hook(wrap({ messages: [message(`wamid.IN-${run}-4`, CONTACT_PHONE, "please stop sending offers")] }))).status).toBe(200);
    await processEvents();
    expect(active()).toBe(1);
    expect((await hook(wrap({ messages: [message(`wamid.IN-${run}-5`, CONTACT_PHONE, "STOP")] }))).status).toBe(200);
    await processEvents();
    expect(active()).toBe(0);
    expect(psql(`select reason from public.suppressions where organization_id = '${ORG.alpha}' and channel = 'whatsapp' and value_normalized = '${CONTACT_PHONE}'`)).toBe("unsubscribe");
    expect(psql(`select status from public.messages where id = '${queued}'`)).toBe("cancelled");
    expect(psql(`select do_not_contact from public.contacts where id = '${contact}'`)).toBe("f");
  });

  it("le contenu des messages n'apparaît dans aucun journal d'audit", () => {
    expect(Number(psql(`select count(*) from public.audit_logs where (coalesce(before::text, '') || coalesce(after::text, '')) like '%Bonjour ${run}%'`))).toBe(0);
  });
});
