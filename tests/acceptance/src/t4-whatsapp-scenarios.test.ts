import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, ORG, psql, purgeIdempotencyKeys } from "../../../supabase/tests/rls/src/harness";
import { BASE_URL, postJson, signIn, type Session } from "./app-client";
import { createSendWorker, drain, parkForeignJobs, providerMock, release, step, unparkJobs } from "./channels.testkit";

/**
 * T4 (spec §13 critère 6 et scénario « conversation WhatsApp démarrée par le client, une autre par un modèle approuvé, webhook en double et
 * panne temporaire du fournisseur ») : la VRAIE route `/api/webhooks/whatsapp` (signature), le VRAI worker (Runner, handlers `process_webhook` et
 * `send_message`, base) et un Meta simulé (`fetch` injecté dans l'adaptateur réel). Vérifié : le même webhook reçu deux fois ne crée qu'un message,
 * la réponse dans la fenêtre part en texte, hors fenêtre seul un modèle approuvé part (sinon refus sans appel), une limite de débit (429) deux fois
 * puis un succès ne donne AUCUN doublon, et une panne 5xx (résultat inconnu) n'est JAMAIS rejouée automatiquement (décision J36 : un 5xx peut avoir
 * été accepté, renvoyer risquerait un doublon). Exige la clé maître (SECRETS_MASTER_KEY, celle de l'application).
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const stamp = String(Date.now()).slice(-9);
const PHONE_ID = `7${stamp}01`;
const KEY_PREFIX = `acc40w${run}`;
const APP_SECRET = `app-secret-${run}-0123456789abcdef0123`;
const TOKEN = `EAAG-jeton-${run}-0123456789`;
const BODY_MARK = `CORPS-WA-${run}`;
const MASTER = process.env.SECRETS_MASTER_KEY;
const VERSION = Number(process.env.SECRETS_KEY_VERSION ?? "1");
const IP = "203.0.113.41";
const PHONES = { a: `+2126${stamp.slice(-8)}`, b: `+2127${stamp.slice(-8)}`, c: `+2128${stamp.slice(-8)}`, d: `+2129${stamp.slice(-8)}` } as const;
type Who = keyof typeof PHONES;
const digits = (who: Who) => PHONES[who].slice(1);

const sessions = new Map<string, Session>();
const as = (who: string): Session => {
  const session = sessions.get(who);
  if (!session) throw new Error(`session absente : ${who}`);
  return session;
};
let counter = 0;
const post = (path: string, payload: unknown) =>
  postJson(as("shared"), path, payload, { activeOrg: ORG.alpha, headers: { "idempotency-key": `${KEY_PREFIX}-${(counter += 1)}-${randomUUID()}` } });
const rpc = <T = unknown>(persona: "service" | "shared", fn: string, args: Record<string, unknown>) => api<T>(persona, "POST", `rpc/${fn}`, args);
const first = (sql: string): string => psql(sql).trim().split("\n").filter((l) => l.length > 0)[0] ?? "";

const wrap = (value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "102290129340398", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550783881", phone_number_id: PHONE_ID }, ...value } }] }],
});
const TS = String(Math.floor(Date.now() / 1000));
const inboundMessage = (id: string, who: Who, text: string) => ({ from: digits(who), id, timestamp: TS, text: { body: text }, type: "text" });
const statusEvent = (id: string, who: Who, s: string) => ({ id, status: s, timestamp: TS, recipient_id: digits(who) });
const sign = (raw: string) => `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;
const hook = (value: unknown) => {
  const raw = JSON.stringify(value);
  return fetch(`${BASE_URL}/api/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": IP, "x-hub-signature-256": sign(raw) }, body: raw });
};

let integration = "";
let channel = "";
let template = "";
let parked: string[] = [];
const contact: Record<string, string> = {};
const conversationOf = (who: Who) => first(`select id from public.conversations where contact_id = '${contact[who]}'`);
const inboundCount = (who: Who) => Number(first(`select count(*) from public.messages where direction = 'inbound' and conversation_id = '${conversationOf(who)}'`));
const status = (id: string) => first(`select status from public.messages where id = '${id}'`);
const errorCode = (id: string) => first(`select coalesce(error_code, '') from public.messages where id = '${id}'`);
const job = (id: string, column: string) => first(`select ${column} from public.jobs where kind = 'send_message' and payload ->> 'message_id' = '${id}'`);

async function outbound(who: Who, label: string): Promise<string> {
  const recorded = await rpc<{ message_id: string }>("service", "message_record", {
    p_org: ORG.alpha, p_conversation: conversationOf(who), p_direction: "outbound", p_provider_message_id: null, p_body: `${BODY_MARK} ${who} ${label}`, p_idempotency_key: `t4${run}${who}${label}`, p_event_at: null,
  });
  expect(recorded.status).toBe(200);
  return recorded.body.message_id;
}
const approve = async (message: string, purpose: string) => expect((await rpc("shared", "message_approve", { p_org: ORG.alpha, p_message: message, p_purpose: purpose })).status).toBe(204);

const cleanup = () => {
  psql(`
    begin;
    set local session_replication_role = replica;
    delete from public.jobs where payload ->> 'message_id' in (select id::text from public.messages where idempotency_key like 't4${run}%')
      or payload ->> 'event_id' in (select id::text from public.webhook_events where integration_id in (select id from public.integrations where external_account_id = '${PHONE_ID}'));
    delete from public.inbound_unmatched where integration_id in (select id from public.integrations where external_account_id = '${PHONE_ID}');
    delete from public.webhook_events where integration_id in (select id from public.integrations where external_account_id = '${PHONE_ID}');
    delete from public.consent_events where contact_id in (select id from public.contacts where email_normalized like '%@t4${run}.test');
    delete from public.messages where conversation_id in (select id from public.conversations where contact_id in (select id from public.contacts where email_normalized like '%@t4${run}.test'));
    delete from public.conversations where contact_id in (select id from public.contacts where email_normalized like '%@t4${run}.test');
    delete from public.message_templates where channel_id in (select id from public.channels where integration_id in (select id from public.integrations where external_account_id = '${PHONE_ID}'));
    delete from public.channels where integration_id in (select id from public.integrations where external_account_id = '${PHONE_ID}');
    delete from private.secrets where id in (select secret_ref from public.integrations where external_account_id = '${PHONE_ID}')
      or id in (select webhook_secret_ref from public.integrations where external_account_id = '${PHONE_ID}');
    delete from public.integrations where external_account_id = '${PHONE_ID}';
    delete from public.contacts where email_normalized like '%@t4${run}.test';
    commit;
  `);
  purgeIdempotencyKeys(KEY_PREFIX);
};

beforeAll(async () => {
  cleanup();
  sessions.set("shared", await signIn("shared@seed.test"));
  if (!MASTER) return;
  parked = parkForeignJobs();
  expect((await post("/api/integrations", { provider: "whatsapp", gateway: "meta", external_account_id: PHONE_ID, scopes: [], secret: TOKEN })).status).toBe(201);
  integration = first(`select id from public.integrations where external_account_id = '${PHONE_ID}'`);
  expect((await post("/api/integrations/webhook-secret", { integration_id: integration, secret: APP_SECRET })).status).toBe(200);
  psql(`
    update public.integrations set status = 'active' where id = '${integration}';
    insert into public.channels (organization_id, type, integration_id, sender_identity, status) values ('${ORG.alpha}', 'whatsapp', '${integration}', '+15550783881', 'active');
  `);
  channel = first(`select id from public.channels where integration_id = '${integration}'`);
  for (const who of ["a", "b", "c", "d"] as const) {
    psql(`insert into public.contacts (organization_id, name, email_raw, email_normalized, phone_e164) values ('${ORG.alpha}', 'T4 ${who} ${run}', '${who}@t4${run}.test', '${who}@t4${run}.test', '${PHONES[who]}')`);
    contact[who] = first(`select id from public.contacts where organization_id = '${ORG.alpha}' and email_normalized = '${who}@t4${run}.test'`);
  }
  // a, c, d : ont écrit (fenêtre de 24 h ouverte) ET ont un consentement WhatsApp « service ». La finalité « reply » est réservée à la réponse du composeur de la boîte
  // de réception, qui ne gère que l'e-mail : un message WhatsApp dans la fenêtre s'approuve donc avec une finalité à consentement enregistré.
  for (const who of ["a", "c", "d"] as const) {
    psql(`insert into public.consent_events (organization_id, contact_id, channel, purpose, source) values ('${ORG.alpha}', '${contact[who]}', 'whatsapp', 'service', 'form')`);
  }
  // b : contact joint par MODÈLE (aucun message reçu) : consentement WhatsApp marketing enregistré ; conversation créée à la main
  psql(`insert into public.consent_events (organization_id, contact_id, channel, purpose, source) values ('${ORG.alpha}', '${contact.b}', 'whatsapp', 'marketing', 'form')`);
  await rpc("service", "conversation_get_or_create", { p_org: ORG.alpha, p_contact: contact.b, p_channel: channel });
  const items = [{ name: "offre_ete", language: "fr", category: "marketing", status: "approved", components: [{ type: "BODY", text: "Bonjour {{1}}" }] }];
  expect((await rpc("service", "message_templates_sync", { p_org: ORG.alpha, p_channel: channel, p_items: items })).status).toBe(200);
  template = first(`select id from public.message_templates where name = 'offre_ete' and channel_id = '${channel}' order by version desc limit 1`);
});
afterAll(() => {
  cleanup();
  unparkJobs(parked);
});

describe.skipIf(!MASTER)("T4 : WhatsApp (client, modèle, webhook en double, panne du fournisseur)", () => {
  // c : deux limites de débit (429) puis un succès ; d : un 503 (résultat inconnu)
  const provider = providerMock({
    [digits("c")]: [{ status: 429, body: { error: { code: 130429 } } }, { status: 429, body: { error: { code: 130429 } } }],
    [digits("d")]: [{ status: 503, body: { error: { code: 2 } } }],
  });
  let worker: ReturnType<typeof createSendWorker>;
  const wamid = (suffix: string) => `wamid.IN${run}${suffix}`;

  beforeAll(() => {
    worker = createSendWorker({ masterKey: MASTER as string, version: VERSION, provider: provider.fetch });
  });

  it("conversation démarrée PAR LE CLIENT : le webhook signé est accepté, le worker range le message dans la conversation du contact", async () => {
    const body = wrap({ contacts: [{ profile: { name: "Profil" }, wa_id: digits("a") }], messages: [inboundMessage(wamid("a1"), "a", "Bonjour, une question.")] });
    const res = await hook(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "accepted" });
    await drain(worker);
    expect(inboundCount("a")).toBe(1);
    expect(first(`select count(*) from public.conversations where contact_id = '${contact.a}'`)).toBe("1");
    expect(first(`select count(*) from public.webhook_events where integration_id = '${integration}' and status = 'processed'`)).toBe("1");
  });

  it("le MÊME webhook reçu deux fois : doublon à la route, puis retraitement forcé : toujours UN seul message", async () => {
    const body = wrap({ contacts: [{ profile: { name: "Profil" }, wa_id: digits("a") }], messages: [inboundMessage(wamid("a1"), "a", "Bonjour, une question.")] });
    const again = await hook(body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "duplicate" });
    expect(first(`select count(*) from public.webhook_events where integration_id = '${integration}'`)).toBe("1");
    // sans la déduplication de la route : retraiter le même contenu ne crée pas un second message
    psql(`update public.webhook_events set status = 'received', processed_at = null where integration_id = '${integration}'`);
    psql(`select private.enqueue_job('${ORG.alpha}', 'process_webhook', jsonb_build_object('event_id', id), 'replay-${run}-' || id::text, null, 5) from public.webhook_events where integration_id = '${integration}'`);
    await drain(worker);
    expect(inboundCount("a")).toBe(1);
  });

  it("message humain dans la fenêtre de 24 h : un TEXTE part vers le bon numéro, message accepté avec l'identifiant Meta", async () => {
    const reply = await outbound("a", "reponse");
    await approve(reply, "service");
    expect(await drain(worker)).toBe(1);
    const calls = provider.toRecipient(digits("a"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain(`/${PHONE_ID}/messages`);
    expect(calls[0]?.body).toMatchObject({ messaging_product: "whatsapp", type: "text", to: digits("a") });
    expect(status(reply)).toBe("accepted");
    expect(first(`select provider_message_id like 'wamid.%' from public.messages where id = '${reply}'`)).toBe("t");
    // statut « delivered » de Meta, reçu deux fois : appliqué une fois, sans effet la seconde
    const wid = first(`select provider_message_id from public.messages where id = '${reply}'`);
    const delivered = wrap({ statuses: [statusEvent(wid, "a", "delivered")] });
    expect((await hook(delivered)).status).toBe(200);
    expect(await (await hook(delivered)).json()).toEqual({ status: "duplicate" });
    await drain(worker);
    expect(status(reply)).toBe("delivered");
  });

  it("conversation démarrée par MODÈLE (hors fenêtre) : le modèle approuvé part (type template, nom, langue, variable) ; sans modèle : refus, AUCUN appel", async () => {
    const withTemplate = await outbound("b", "modele");
    expect((await rpc("shared", "message_attach_template", { p_org: ORG.alpha, p_message: withTemplate, p_template: template, p_variables: ["Nadia"] })).status).toBeLessThan(300);
    await approve(withTemplate, "marketing");
    const noTemplate = await outbound("b", "texte-libre");
    await approve(noTemplate, "marketing");
    const before = provider.toRecipient(digits("b")).length;
    expect(await drain(worker)).toBe(2);
    const calls = provider.toRecipient(digits("b"));
    expect(calls).toHaveLength(before + 1);
    expect(calls[before]?.body).toMatchObject({ type: "template", to: digits("b"), template: { name: "offre_ete", language: { code: "fr" } } });
    expect(status(withTemplate)).toBe("accepted");
    expect(status(noTemplate)).toBe("failed");
    expect(errorCode(noTemplate)).toMatch(/^refused_/);
  });

  it("limite de débit (429) DEUX FOIS puis 200 : trois tentatives, UN message accepté, UN identifiant Meta, aucun doublon", async () => {
    // c écrit d'abord (fenêtre ouverte) puis reçoit une réponse
    await hook(wrap({ contacts: [{ profile: { name: "C" }, wa_id: digits("c") }], messages: [inboundMessage(wamid("c1"), "c", "Allo")] }));
    await drain(worker);
    const reply = await outbound("c", "reponse");
    await approve(reply, "service");
    expect(await step(worker)).toBe(1);
    expect(status(reply)).toBe("queued");
    expect(provider.toRecipient(digits("c"))).toHaveLength(1);
    release([reply]);
    expect(await step(worker)).toBe(1);
    expect(status(reply)).toBe("queued");
    expect(provider.toRecipient(digits("c"))).toHaveLength(2);
    release([reply]);
    expect(await step(worker)).toBe(1);
    expect(provider.toRecipient(digits("c"))).toHaveLength(3);
    expect(status(reply)).toBe("accepted");
    expect(job(reply, "status")).toBe("succeeded");
    expect(job(reply, "attempts")).toBe("3");
    expect(first(`select count(*) from public.messages where conversation_id = '${conversationOf("c")}' and direction = 'outbound' and provider_message_id is not null`)).toBe("1");
    release([reply]);
    expect(await step(worker)).toBe(0);
    expect(provider.toRecipient(digits("c"))).toHaveLength(3);
  });

  it("panne 503 (résultat inconnu) : UN seul appel, message « failed / send_outcome_unknown », JAMAIS rejoué automatiquement (pas de doublon possible)", async () => {
    await hook(wrap({ contacts: [{ profile: { name: "D" }, wa_id: digits("d") }], messages: [inboundMessage(wamid("d1"), "d", "Bonjour")] }));
    await drain(worker);
    const reply = await outbound("d", "reponse");
    await approve(reply, "service");
    expect(await step(worker)).toBe(1);
    expect(provider.toRecipient(digits("d"))).toHaveLength(1);
    expect(status(reply)).toBe("failed");
    expect(errorCode(reply)).toBe("send_outcome_unknown");
    expect(job(reply, "status")).toBe("succeeded");
    release([reply]);
    expect(await drain(worker)).toBe(0);
    expect(provider.toRecipient(digits("d"))).toHaveLength(1);
  });

  it("compteurs : messages sortants par statut et appels fournisseur cohérents ; aucun corps ni jeton dans l'audit, les en-têtes ou les erreurs de jobs", () => {
    const counts = psql(`select status || ':' || count(*) from public.messages where idempotency_key like 't4${run}%' group by status order by status`).trim().split("\n");
    expect(counts).toEqual(["accepted:2", "delivered:1", "failed:2"]);
    expect(provider.calls).toHaveLength(1 + 1 + 3 + 1);
    expect(first(`select count(*) from public.audit_logs where organization_id = '${ORG.alpha}' and (before::text like '%${BODY_MARK}%' or after::text like '%${BODY_MARK}%' or after::text like '%${TOKEN}%')`)).toBe("0");
    expect(first(`select count(*) from public.jobs where kind in ('send_message', 'process_webhook') and (coalesce(last_error, '') like '%${BODY_MARK}%' or payload::text like '%${BODY_MARK}%')`)).toBe("0");
    for (const call of provider.calls) expect(JSON.stringify(call.headers)).not.toContain(TOKEN);
  });
});
