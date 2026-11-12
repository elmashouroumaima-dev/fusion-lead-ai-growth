import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKeyRing, openOrganizationSecret } from "../../../packages/adapters/src/secrets";
import { createEmailWebhookProcessor, type EmailEventGateway } from "../../../apps/worker/src/email-webhook";
import { createProcessWebhookHandler } from "../../../apps/worker/src/handlers";
import type { WebhookGateway } from "../../../apps/worker/src/webhooks";
import { api, ORG, psql, purgeIdempotencyKeys } from "../../../supabase/tests/rls/src/harness";
import { BASE_URL, postJson, signIn, type Session } from "./app-client";

/**
 * E-mail entrant et statuts (J32, spec §9.2) de bout en bout : la VRAIE route HTTP `/api/webhooks/email` (Basic Auth de Postmark, secret de
 * webhook enregistré par l'API de l'application), les VRAIES fonctions SQL et le VRAI handler `process_webhook` du worker. Scénarios : le
 * secret de webhook (rôles, jamais renvoyé, chiffré avec la clé de l'application), authentification refusée (mauvais mot de passe, compte inconnu),
 * delivered, rebond dur (suppression SANS do_not_contact), plainte (suppression ET do_not_contact), réponse rattachée à la bonne conversation,
 * expéditeur inconnu ou non authentifié (file des cas ambigus, aucun contact créé), rejeu sans second effet.
 * Exige la clé maître (SECRETS_MASTER_KEY, la même que celle de l'application) : sans elle, le flux entier est ignoré.
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ACCOUNT = `acc32${run}`;
const KEY_PREFIX = `acc32${run}`;
const SECRET = `webhook-secret-${run}-0123456789abcdef`;
const SEND_TOKEN = `jeton-envoi-${run}-0123456789`;
const MASTER = process.env.SECRETS_MASTER_KEY;
const VERSION = Number(process.env.SECRETS_KEY_VERSION ?? "1");
const keyRing = MASTER ? createKeyRing(VERSION, { [VERSION]: MASTER }) : null;
const IP = "203.0.113.32";

const sessions = new Map<string, Session>();
const as = (who: string): Session => {
  const session = sessions.get(who);
  if (!session) throw new Error(`session absente : ${who}`);
  return session;
};
let counter = 0;
const post = (who: string | null, path: string, payload: unknown) =>
  postJson(who ? as(who) : null, path, payload, { activeOrg: ORG.alpha, headers: { "idempotency-key": `${KEY_PREFIX}-${(counter += 1)}-${randomUUID()}` } });

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
const hook = (payload: unknown, authorization: string | null = basic(ACCOUNT, SECRET)) =>
  fetch(`${BASE_URL}/api/webhooks/email`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": IP, ...(authorization ? { authorization } : {}) },
    body: JSON.stringify(payload),
  });

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
const emailGateway: EmailEventGateway = {
  async applyStatus(org, integration, event) {
    const result = await rpc<{ outcome: "applied" | "ignored"; reason?: string }>("email_status_apply", {
      p_org: org, p_integration: integration, p_event: event.kind, p_hard: event.kind === "bounced" ? event.hard : false,
      p_provider_message_id: event.providerMessageId, p_ref: event.ref, p_event_at: event.at,
    });
    if (result.status !== 200) throw new Error(`email_status_${result.status}`);
    return result.body;
  },
  async applyInbound(org, integration, event) {
    const result = await rpc<{ outcome: "recorded" | "duplicate" | "unmatched"; reason?: string }>("email_inbound_apply", {
      p_org: org, p_integration: integration, p_provider_message_id: event.providerMessageId, p_recipients: event.recipients, p_from: event.from,
      p_subject: event.subject, p_body: event.body, p_received_at: event.at, p_verified: event.spfPass, p_spam: event.spam,
    });
    if (result.status !== 200) throw new Error(`email_inbound_${result.status}`);
    return result.body;
  },
};
const handler = createProcessWebhookHandler(webhookGateway, new Map([["email", createEmailWebhookProcessor(emailGateway)]]));
const processEvent = async (where: string): Promise<void> => {
  const eventId = psql(`select id from public.webhook_events where integration_id = '${integration}' and external_event_id like '${where}' order by received_at desc limit 1`);
  expect(eventId, where).toMatch(/^[0-9a-f-]{36}$/);
  await handler.run({ jobId: randomUUID(), organizationId: ORG.alpha, idempotencyKey: `process_webhook:${eventId}`, attempt: 1, maxAttempts: 5, signal: new AbortController().signal }, { event_id: eventId });
};

let integration = "";
let channel = "";
const contact: Record<string, string> = {};
const message: Record<string, string> = {};

const cleanup = () => {
  psql(`
    set session_replication_role = replica;
    delete from public.jobs where kind = 'process_webhook' and payload ->> 'event_id' in (select id::text from public.webhook_events where integration_id in (select id from public.integrations where external_account_id like '${ACCOUNT}%'));
    delete from public.webhook_events where integration_id in (select id from public.integrations where external_account_id like '${ACCOUNT}%');
    delete from public.inbound_unmatched where integration_id in (select id from public.integrations where external_account_id like '${ACCOUNT}%');
    delete from public.suppressions where value_normalized like '%@ef${run}.test';
    delete from public.messages where conversation_id in (select id from public.conversations where contact_id in (select id from public.contacts where email_normalized like '%@ef${run}.test'));
    delete from public.conversations where contact_id in (select id from public.contacts where email_normalized like '%@ef${run}.test');
    delete from public.channels where integration_id in (select id from public.integrations where external_account_id like '${ACCOUNT}%');
    delete from private.secrets where id in (select secret_ref from public.integrations where external_account_id like '${ACCOUNT}%')
      or id in (select webhook_secret_ref from public.integrations where external_account_id like '${ACCOUNT}%');
    delete from public.integrations where external_account_id like '${ACCOUNT}%';
    delete from public.contacts where email_normalized like '%@ef${run}.test';
  `);
  purgeIdempotencyKeys(KEY_PREFIX);
};

const deliveryPayload = (id: string, recipient: string, ref?: string) => ({
  RecordType: "Delivery", MessageStream: "outbound", ServerID: 23, MessageID: id, Recipient: recipient, Tag: "t", DeliveredAt: "2026-11-05T16:33:54.9070259Z", Details: "250 OK",
  Metadata: ref ? { fusion_message_id: ref } : {},
});
const bouncePayload = (bounceId: number, id: string, email: string, typeCode: number) => ({
  RecordType: "Bounce", MessageStream: "outbound", ID: bounceId, Type: typeCode === 1 ? "HardBounce" : "Transient", TypeCode: typeCode, MessageID: id, Email: email,
  BouncedAt: "2026-11-05T16:33:54.9070259Z", Content: "<Full dump of bounce>", Metadata: {},
});
const complaintPayload = (id: number, messageId: string, email: string) => ({
  RecordType: "SpamComplaint", MessageStream: "outbound", ID: id, TypeCode: 100001, MessageID: messageId, Email: email, BouncedAt: "2026-11-05T16:33:54.9070259Z", Metadata: {},
});
const inboundPayload = (id: string, from: string, to: string, spf = `Pass (sender SPF authorized) identity=mailfrom; envelope-from=${from}`) => ({
  From: from, MessageStream: "inbound", FromFull: { Email: from, Name: "Expéditeur" }, To: to, ToFull: [{ Email: to, Name: "", MailboxHash: "" }], OriginalRecipient: to,
  Subject: "Re: votre offre", MessageID: id, Date: "Thu, 5 Nov 2026 16:59:01 +0100", TextBody: `SECRET-REPONSE-${run} merci pour votre offre`, HtmlBody: "<p>html</p>",
  Headers: [{ Name: "Received-SPF", Value: spf }, { Name: "X-Spam-Status", Value: "No" }],
  Attachments: [{ Name: "a.png", Content: "QkFTRTY0", ContentType: "image/png", ContentLength: 8, ContentID: "" }],
});

beforeAll(async () => {
  cleanup();
  for (const name of ["shared", "alpha-admin", "alpha-marketing", "alpha-sales", "alpha-analyst", "beta-owner"]) sessions.set(name, await signIn(`${name}@seed.test`));
  if (!keyRing) return;
  // intégration e-mail créée par l'API de l'application (jeton d'envoi chiffré), canal et contacts préparés en base
  const created = await post("shared", "/api/integrations", { provider: "email", external_account_id: ACCOUNT, scopes: [], secret: SEND_TOKEN });
  expect(created.status).toBe(201);
  integration = psql(`select id from public.integrations where external_account_id = '${ACCOUNT}'`);
  psql(`
    update public.integrations set status = 'active' where id = '${integration}';
    insert into public.channels (organization_id, type, integration_id, sender_identity, status) values ('${ORG.alpha}', 'email', '${integration}', 'ventes@ef${run}.test', 'active');
    insert into public.contacts (organization_id, name, email_raw, email_normalized) values
      ('${ORG.alpha}', 'EF K1 ${run}', 'k1@ef${run}.test', 'k1@ef${run}.test'),
      ('${ORG.alpha}', 'EF K2 ${run}', 'k2@ef${run}.test', 'k2@ef${run}.test'),
      ('${ORG.alpha}', 'EF K3 ${run}', 'k3@ef${run}.test', 'k3@ef${run}.test');
  `);
  channel = psql(`select id from public.channels where integration_id = '${integration}'`);
  for (const key of ["k1", "k2", "k3"]) {
    contact[key] = psql(`select id from public.contacts where email_normalized = '${key}@ef${run}.test'`);
    const conv = String(((await rpc("conversation_get_or_create", { p_org: ORG.alpha, p_contact: contact[key], p_channel: channel })).body as { id: string }).id);
    const recorded = await rpc<{ message_id: string }>("message_record", { p_org: ORG.alpha, p_conversation: conv, p_direction: "outbound", p_provider_message_id: null, p_body: `Bonjour ${key}`, p_idempotency_key: `ef${run}${key}0001`, p_event_at: null });
    message[key] = recorded.body.message_id;
    psql(`update public.messages set approved_by = (select id from auth.users where email = 'shared@seed.test'), approved_at = now(), approved_purpose = 'marketing',
      approved_recipient = '${key}@ef${run}.test', status = 'accepted', provider_message_id = 'pm-${run}-${key}', send_claimed_at = now(), sent_at = now() where id = '${message[key]}'`);
  }
});
afterAll(cleanup);

describe.skipIf(!keyRing)("secret de webhook", () => {
  it("commercial, marketing, analyste : 403 ; anonyme : 401 ; secret trop court, organization_id ou sans clé d'idempotence : 400", async () => {
    for (const who of ["alpha-sales", "alpha-marketing", "alpha-analyst"]) expect((await post(who, "/api/integrations/webhook-secret", { integration_id: integration, secret: SECRET })).status, who).toBe(403);
    expect((await post(null, "/api/integrations/webhook-secret", { integration_id: integration, secret: SECRET })).status).toBe(401);
    expect((await post("shared", "/api/integrations/webhook-secret", { integration_id: integration, secret: "court" })).status).toBe(400);
    expect((await post("shared", "/api/integrations/webhook-secret", { integration_id: integration, secret: SECRET, organization_id: ORG.beta })).status).toBe(400);
    expect((await postJson(as("shared"), "/api/integrations/webhook-secret", { integration_id: integration, secret: SECRET }, { activeOrg: ORG.alpha })).status).toBe(400);
    expect(psql(`select has_webhook_secret from public.integrations where id = '${integration}'`)).toBe("f");
  });

  it("le secret de webhook ne peut PAS être le jeton d'envoi : 400, rien n'est enregistré", async () => {
    expect((await post("shared", "/api/integrations/webhook-secret", { integration_id: integration, secret: SEND_TOKEN })).status).toBe(400);
    expect(psql(`select has_webhook_secret from public.integrations where id = '${integration}'`)).toBe("f");
  });

  it("l'owner d'une autre entreprise ne peut pas viser cette intégration ; l'owner d'Alpha l'enregistre : 200, secret jamais renvoyé", async () => {
    const crossed = await postJson(as("beta-owner"), "/api/integrations/webhook-secret", { integration_id: integration, secret: SECRET }, { activeOrg: ORG.beta, headers: { "idempotency-key": `${KEY_PREFIX}-x-${randomUUID()}` } });
    expect(crossed.status).toBe(404);
    const ok = await post("shared", "/api/integrations/webhook-secret", { integration_id: integration, secret: SECRET });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ replaced: true });
    expect(JSON.stringify(ok.json)).not.toContain(SECRET);
    expect(psql(`select has_webhook_secret from public.integrations where id = '${integration}'`)).toBe("t");
  });

  it("réciproquement, le jeton d'envoi ne peut pas être remplacé par le secret de webhook : 400", async () => {
    expect((await post("shared", "/api/integrations/secret", { integration_id: integration, secret: SECRET })).status).toBe(400);
  });

  it("le secret est chiffré avec la clé de l'application (AAD de l'entreprise), absent de l'audit et des clés d'idempotence", async () => {
    const stored = JSON.parse(psql(`select to_jsonb(s) from private.secrets s where s.id = (select webhook_secret_ref from public.integrations where id = '${integration}')`)) as {
      id: string; ciphertext: string; nonce: string; key_version: number; organization_id: string;
    };
    expect(stored.organization_id).toBe(ORG.alpha);
    expect(stored.ciphertext).not.toContain(SECRET);
    expect(openOrganizationSecret({ organizationId: ORG.alpha, stored: { secretId: stored.id, ciphertext: stored.ciphertext, nonce: stored.nonce, keyVersion: stored.key_version }, keyRing: keyRing! })).toBe(SECRET);
    expect(psql(`select count(*) from public.audit_logs a where to_jsonb(a)::text like '%${SECRET}%'`)).toBe("0");
    expect(psql(`select count(*) from public.idempotency_keys k where to_jsonb(k)::text like '%${SECRET}%'`)).toBe("0");
  });
});

describe.skipIf(!keyRing)("route /api/webhooks/email : authentification Basic", () => {
  it("sans en-tête : 400 ; mauvais mot de passe : 401 avec trace SANS payload ; compte inconnu : le MÊME 401, aucune trace", async () => {
    expect((await hook(deliveryPayload(`pm-${run}-k1`, `k1@ef${run}.test`), null)).status).toBe(400);
    const wrong = await hook(deliveryPayload(`pm-${run}-k1`, `k1@ef${run}.test`), basic(ACCOUNT, "mauvais-mot-de-passe"));
    expect(wrong.status).toBe(401);
    const unknown = await hook(deliveryPayload(`pm-${run}-k1`, `k1@ef${run}.test`), basic(`inconnu${run}`, SECRET));
    expect(unknown.status).toBe(401);
    // même réponse (le request_id, propre à chaque requête, mis à part) : aucun oracle d'existence d'un compte
    const strip = ({ code, message }: { code?: string; message?: string }) => ({ code, message });
    expect(strip((await unknown.json()) as { code?: string; message?: string })).toEqual(strip((await wrong.json()) as { code?: string; message?: string }));
    expect(psql(`select count(*) from public.webhook_events where integration_id = '${integration}' and status = 'rejected'`)).toBe("1");
    expect(psql(`select count(*) from public.webhook_events where integration_id = '${integration}' and payload is not null`)).toBe("0");
  });

  it("un événement d'un autre type (ouverture) est acquitté 200 puis ignoré ; un JSON invalide est refusé 400", async () => {
    expect((await hook({ RecordType: "Open", MessageID: "x" })).status).toBe(200);
    const invalid = await fetch(`${BASE_URL}/api/webhooks/email`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": IP, authorization: basic(ACCOUNT, SECRET) }, body: "pas du json" });
    expect(invalid.status).toBe(400);
  });
});

describe.skipIf(!keyRing)("statuts du fournisseur", () => {
  it("delivered : 200 accepted, rejeu = duplicate, puis le worker passe le message à « delivered » (accepted ≠ delivered)", async () => {
    expect(psql(`select status from public.messages where id = '${message.k1}'`)).toBe("accepted");
    const first = await hook(deliveryPayload(`pm-${run}-k1`, `k1@ef${run}.test`));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: "accepted" });
    expect(await (await hook(deliveryPayload(`pm-${run}-k1`, `k1@ef${run}.test`))).json()).toEqual({ status: "duplicate" });
    expect(psql(`select count(*) from public.webhook_events where integration_id = '${integration}' and external_event_id like 'delivery:pm-${run}-k1:%'`)).toBe("1");
    await processEvent(`delivery:pm-${run}-k1:%`);
    expect(psql(`select status from public.messages where id = '${message.k1}'`)).toBe("delivered");
    expect(psql(`select status from public.webhook_events where external_event_id like 'delivery:pm-${run}-k1:%' and integration_id = '${integration}'`)).toBe("processed");
  });

  it("rebond doux : sans effet ; rebond dur : message « bounced », adresse supprimée, do_not_contact INCHANGÉ", async () => {
    await hook(bouncePayload(9_000_001, `pm-${run}-k2`, `k2@ef${run}.test`, 2));
    await processEvent("bounce:9000001");
    expect(psql(`select status from public.messages where id = '${message.k2}'`)).toBe("accepted");
    expect(psql(`select count(*) from public.suppressions where value_normalized = 'k2@ef${run}.test'`)).toBe("0");
    expect((await hook(bouncePayload(9_000_002, `pm-${run}-k2`, `k2@ef${run}.test`, 1))).status).toBe(200);
    await processEvent("bounce:9000002");
    expect(psql(`select status from public.messages where id = '${message.k2}'`)).toBe("bounced");
    expect(psql(`select reason from public.suppressions where value_normalized = 'k2@ef${run}.test'`)).toBe("bounce");
    expect(psql(`select do_not_contact from public.contacts where id = '${contact.k2}'`)).toBe("f");
    expect(psql(`select count(*) from public.webhook_events a where to_jsonb(a)::text like '%Full dump%'`)).toBe("0");
  });

  it("plainte : adresse supprimée ET do_not_contact = true ; le statut du message ne change pas", async () => {
    expect((await hook(complaintPayload(9_000_003, `pm-${run}-k3`, `k3@ef${run}.test`))).status).toBe(200);
    await processEvent("complaint:9000003");
    expect(psql(`select reason from public.suppressions where value_normalized = 'k3@ef${run}.test'`)).toBe("complaint");
    expect(psql(`select do_not_contact from public.contacts where id = '${contact.k3}'`)).toBe("t");
    expect(psql(`select status from public.messages where id = '${message.k3}'`)).toBe("accepted");
    expect(psql(`select count(*) from public.audit_logs where organization_id = '${ORG.alpha}' and action = 'contact.do_not_contact_changed' and entity_id = '${contact.k3}'`)).toBe("1");
  });

  it("l'événement d'Alpha ne touche rien chez Beta : un job d'une autre entreprise ne traite pas l'événement", async () => {
    await hook(deliveryPayload(`pm-${run}-k2`, `k2@ef${run}.test`));
    const eventId = psql(`select id from public.webhook_events where integration_id = '${integration}' and external_event_id like 'delivery:pm-${run}-k2:%'`);
    await handler.run({ jobId: randomUUID(), organizationId: ORG.beta, idempotencyKey: "x", attempt: 1, maxAttempts: 5, signal: new AbortController().signal }, { event_id: eventId });
    expect(psql(`select status from public.webhook_events where id = '${eventId}'`)).toBe("received");
  });
});

describe.skipIf(!keyRing)("e-mail entrant", () => {
  const to = () => `ventes@ef${run}.test`;

  it("la réponse d'un contact connu est rattachée à SA conversation et à CE canal ; pièces jointes et HTML non conservés ; rejeu = un seul message", async () => {
    expect((await hook(inboundPayload(`in-${run}-1`, `k1@ef${run}.test`, to()))).status).toBe(200);
    expect(await (await hook(inboundPayload(`in-${run}-1`, `k1@ef${run}.test`, to()))).json()).toEqual({ status: "duplicate" });
    await processEvent(`inbound:in-${run}-1`);
    expect(psql(`select count(*) from public.messages where provider_message_id = 'in-${run}-1' and direction = 'inbound'`)).toBe("1");
    expect(psql(`select c.contact_id = '${contact.k1}' and c.channel_id = '${channel}' from public.messages m join public.conversations c on c.id = m.conversation_id where m.provider_message_id = 'in-${run}-1'`)).toBe("t");
    expect(psql(`select count(*) from public.webhook_events where integration_id = '${integration}' and (payload::text like '%QkFTRTY0%' or payload::text like '%<p>html</p>%')`)).toBe("0");
    expect(psql(`select count(*) from public.audit_logs where to_jsonb(audit_logs)::text like '%SECRET-REPONSE-${run}%'`)).toBe("0");
  });

  it("un contact « ne plus contacter » (plainte) peut quand même répondre : le message est enregistré", async () => {
    await hook(inboundPayload(`in-${run}-2`, `k3@ef${run}.test`, to()));
    await processEvent(`inbound:in-${run}-2`);
    expect(psql(`select count(*) from public.messages where provider_message_id = 'in-${run}-2'`)).toBe("1");
  });

  it("expéditeur inconnu, expéditeur non authentifié (SPF) et adresse sans canal : file des cas ambigus, AUCUN contact créé", async () => {
    const contactsBefore = psql(`select count(*) from public.contacts where organization_id = '${ORG.alpha}'`);
    await hook(inboundPayload(`in-${run}-3`, `inconnu@ef${run}.test`, to()));
    await hook(inboundPayload(`in-${run}-4`, `k1@ef${run}.test`, to(), "Fail (domain does not designate)"));
    await hook(inboundPayload(`in-${run}-5`, `k1@ef${run}.test`, `autre@ef${run}.test`));
    // USURPATION : l'attaquant passe SPF avec SON domaine et affiche l'adresse du contact k1
    await hook(inboundPayload(`in-${run}-6`, `k1@ef${run}.test`, to(), "Pass (ok) identity=mailfrom; envelope-from=attaquant@attacker.test"));
    for (const n of [3, 4, 5, 6]) await processEvent(`inbound:in-${run}-${n}`);
    expect(psql(`select string_agg(reason, ',' order by provider_message_id) from public.inbound_unmatched where integration_id = '${integration}'`)).toBe("unknown_sender,sender_unverified,no_channel,sender_unverified");
    expect(psql(`select count(*) from public.messages where provider_message_id in ('in-${run}-3', 'in-${run}-4', 'in-${run}-5', 'in-${run}-6')`)).toBe("0");
    expect(psql(`select count(*) from public.contacts where organization_id = '${ORG.alpha}'`)).toBe(contactsBefore);
  });

  it("la file des cas ambigus : owner et admin la lisent par l'API ; marketing, commercial, analyste et Beta : rien", async () => {
    const read = async (persona: "shared" | "alphaAdmin" | "alphaMarketing" | "alphaSales" | "alphaAnalyst" | "betaOwner") =>
      (await api<unknown[]>(persona, "GET", `inbound_unmatched?integration_id=eq.${integration}&select=id,reason,status`)).body.length;
    expect(await read("shared")).toBe(4);
    expect(await read("alphaAdmin")).toBe(4);
    for (const persona of ["alphaMarketing", "alphaSales", "alphaAnalyst", "betaOwner"] as const) expect(await read(persona), persona).toBe(0);
  });
});
