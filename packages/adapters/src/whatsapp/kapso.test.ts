import { describe, expect, it, vi } from "vitest";
import { ingestWebhook } from "../webhooks/ingest";
import { signHmacSha256Hex } from "../webhooks/hmac";
import type { WebhookStore } from "../webhooks/types";
import { createKapsoClient, createKapsoSender, createWhatsAppGatewaySender, KAPSO_BASE, kapsoWebhookAdapter, normalizeKapsoPayload } from "./kapso";
import { createWhatsAppSender } from "./send";
import { readWhatsAppPayload } from "./events";
import { whatsappWebhookAdapter } from "./webhook";

const SECRET = "kapso-secret-0123456789abcdef0123456789abcdef";
const KEY = "kapso-api-key-SECRET-0123456789";
const PHONE = "597907523413541";
const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const received = (over: Record<string, unknown> = {}) => ({
  phone_number_id: PHONE,
  is_new_conversation: false,
  conversation: { id: "conv_1", phone_number: "212600000001" },
  message: { id: "wamid.IN1", timestamp: "1730092800", type: "text", from: "212600000001", text: { body: "Bonjour" }, kapso: { direction: "inbound", status: "received" }, ...over },
});
const outbound = (status: string, extra: Record<string, unknown> = {}) => ({
  phone_number_id: PHONE,
  message: { id: "wamid.OUT1", timestamp: "1730092900", type: "text", to: "212600000001", kapso: { direction: "outbound", status, statuses: [{ id: "wamid.OUT1", status, timestamp: "1730092901", ...extra }] } },
});

describe("signature des webhooks Kapso (refus d'abord)", () => {
  const body = enc(received());
  const valid = () => signHmacSha256Hex(SECRET, body);
  const check = (headers: Record<string, string | undefined>, secret: string | null = SECRET, raw = body) => kapsoWebhookAdapter.verify({ rawBody: raw, headers, secret });

  it("signature fausse, absente, avec préfixe « sha256= », trop courte, majuscules mal formées ou secret absent : refusée", () => {
    expect(check({ "x-webhook-signature": "0".repeat(64) })).toBe(false);
    expect(check({})).toBe(false);
    expect(check({ "x-webhook-signature": `sha256=${valid()}` })).toBe(false);
    expect(check({ "x-webhook-signature": valid().slice(0, 62) })).toBe(false);
    expect(check({ "x-webhook-signature": "zz".repeat(32) })).toBe(false);
    expect(check({ "x-webhook-signature": valid() }, null)).toBe(false);
  });

  it("corps modifié d'un octet, ou signature d'un autre secret : refusée ; ni l'en-tête de Meta ni un en-tête d'idempotence ne suffisent", () => {
    const tampered = new Uint8Array(body);
    tampered[tampered.length - 3] = (tampered[tampered.length - 3] ?? 0) ^ 1;
    expect(check({ "x-webhook-signature": valid() }, SECRET, tampered)).toBe(false);
    expect(check({ "x-webhook-signature": signHmacSha256Hex("autre-secret-0123456789abcdef0123456789", body) })).toBe(false);
    expect(check({ "x-hub-signature-256": `sha256=${valid()}` })).toBe(false);
    expect(check({ "x-idempotency-key": "abc" })).toBe(false);
  });

  it("signature valide (hexadécimale sans préfixe, corps brut) : acceptée", () => {
    expect(check({ "x-webhook-signature": valid() })).toBe(true);
    expect(check({ "x-webhook-signature": valid().toUpperCase() })).toBe(true);
  });

  it("l'adaptateur de Meta refuse la signature de Kapso (en-têtes différents) et inversement", () => {
    expect(whatsappWebhookAdapter.verify({ rawBody: body, headers: { "x-webhook-signature": valid() }, secret: SECRET })).toBe(false);
    expect(kapsoWebhookAdapter.verify({ rawBody: body, headers: { "x-hub-signature-256": `sha256=${valid()}` }, secret: SECRET })).toBe(false);
  });
});

describe("analyse des événements Kapso", () => {
  it("message reçu : numéro avec « + », texte, date ; un numéro déjà préfixé par « + » est accepté", () => {
    const parsed = normalizeKapsoPayload(received());
    expect(parsed).toEqual({
      object: "whatsapp_business_account", phoneNumberIds: [PHONE], skipped: 0,
      events: [{ kind: "message", id: "wamid.IN1", from: "+212600000001", at: "2024-10-28T05:20:00.000Z", type: "text", text: "Bonjour" }],
    });
    expect(normalizeKapsoPayload(received({ from: "+212600000001" }))?.events[0]).toMatchObject({ from: "+212600000001" });
  });

  it("la forme produite est celle que le worker relit (readWhatsAppPayload)", () => {
    expect(readWhatsAppPayload(normalizeKapsoPayload(received()))).not.toBeNull();
    expect(readWhatsAppPayload(normalizeKapsoPayload(outbound("delivered")))).not.toBeNull();
  });

  it("statuts de NOS messages : sent, delivered, read, failed (code d'erreur numérique, jamais son texte)", () => {
    for (const status of ["sent", "delivered", "read"]) {
      expect(normalizeKapsoPayload(outbound(status))?.events).toEqual([{ kind: "status", id: "wamid.OUT1", status, at: "2024-10-28T05:21:41.000Z", errorCode: null }]);
    }
    const failed = normalizeKapsoPayload(outbound("failed", { errors: [{ code: 131047, title: "Re-engagement message", message: "texte du fournisseur" }] }));
    expect(failed?.events).toEqual([{ kind: "status", id: "wamid.OUT1", status: "failed", at: "2024-10-28T05:21:41.000Z", errorCode: 131047 }]);
    expect(JSON.stringify(failed)).not.toContain("texte du fournisseur");
  });

  it("lot (batch) : tous les messages sont lus ; un lot qui mélange deux numéros est refusé", () => {
    const batch = { type: "whatsapp.message.received", batch: true, data: [received(), received({ id: "wamid.IN2" })], batch_info: { size: 2 } };
    expect(normalizeKapsoPayload(batch)?.events).toHaveLength(2);
    expect(normalizeKapsoPayload({ ...batch, data: [received(), { ...received(), phone_number_id: "111111111111111" }] })).toBeNull();
    expect(normalizeKapsoPayload({ batch: true, data: [] })).toBeNull();
  });

  it("événements sans message (conversation, contact), types de réaction, expéditeur invalide, statut inconnu : ignorés et comptés, rien d'inventé", () => {
    expect(normalizeKapsoPayload({ phone_number_id: PHONE, conversation: { id: "conv_1" } })).toMatchObject({ events: [], skipped: 1 });
    expect(normalizeKapsoPayload(received({ type: "reaction" }))).toMatchObject({ events: [], skipped: 1 });
    expect(normalizeKapsoPayload(received({ from: "pas-un-numero" }))).toMatchObject({ events: [], skipped: 1 });
    expect(normalizeKapsoPayload(outbound("queued"))).toMatchObject({ events: [], skipped: 1 });
  });

  it("structure inattendue : null (jamais d'exception) ; numéro absent ou invalide : null", () => {
    for (const bad of [null, 42, "x", [], {}, { phone_number_id: 12345 }, { phone_number_id: "abc", message: {} }]) expect(normalizeKapsoPayload(bad), JSON.stringify(bad)).toBeNull();
  });

  it("aucun profil, nom, média ni corps brut n'est conservé", () => {
    const withProfile = received();
    (withProfile.conversation as Record<string, unknown>).contact_name = "Nom Prive";
    (withProfile.message as Record<string, unknown>).kapso = { direction: "inbound", media_url: "https://exemple.test/m.jpg", content: "autre" };
    const text = JSON.stringify(normalizeKapsoPayload(withProfile));
    for (const leak of ["Nom Prive", "exemple.test", "autre", "conv_1"]) expect(text).not.toContain(leak);
  });
});

describe("pipeline d'ingestion Kapso : intégration retrouvée par numéro ET passerelle", () => {
  function store() {
    const resolve = vi.fn(async (_provider: string, account: string, gateway?: string) => (account === PHONE && gateway === "kapso" ? { organizationId: "org-1", integrationId: "int-1" } : null));
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- le paramètre type les appels relus par les assertions
    const record = vi.fn(async (_input: { provider: string; externalEventId: string }) => ({ eventId: "ev-1", duplicate: false }));
    const recordRejection = vi.fn(async () => undefined);
    return { resolve, record, recordRejection } as unknown as WebhookStore & { resolve: typeof resolve; record: typeof record; recordRejection: typeof recordRejection };
  }
  const run = (body: Uint8Array, headers: Record<string, string>, s: WebhookStore, secret: string | null = SECRET) =>
    ingestWebhook({ adapter: kapsoWebhookAdapter, rawBody: body, headers, store: s, readSecret: async () => secret });

  it("signature valide : l'événement est enregistré sous le fournisseur « whatsapp » (même traitement que Meta) ; les en-têtes d'idempotence non signés sont ignorés", async () => {
    const s = store();
    const body = enc(received());
    const result = await run(body, { "x-webhook-signature": signHmacSha256Hex(SECRET, body), "x-idempotency-key": "autre-cle" }, s);
    expect(result.kind).toBe("accepted");
    expect(s.resolve).toHaveBeenCalledWith("whatsapp", PHONE, "kapso");
    const call = s.record.mock.calls[0]?.[0] as { provider: string; externalEventId: string };
    expect(call.provider).toBe("whatsapp");
    expect(call.externalEventId).toMatch(/^kp:[0-9a-f]{40}$/);
    // le même contenu redonne le même identifiant : la déduplication ne dépend pas d'un en-tête
    const again = await run(body, { "x-webhook-signature": signHmacSha256Hex(SECRET, body), "x-idempotency-key": "encore-une-autre" }, s);
    expect((s.record.mock.calls[1]?.[0] as { externalEventId: string }).externalEventId).toBe(call.externalEventId);
    expect(again.kind).toBe("accepted");
  });

  it("signature fausse : refus, rejet tracé sans contenu, rien d'enregistré", async () => {
    const s = store();
    const result = await run(enc(received()), { "x-webhook-signature": "0".repeat(64) }, s);
    expect(result.kind).toBe("invalid_signature");
    expect(s.record).not.toHaveBeenCalled();
    expect(s.recordRejection).toHaveBeenCalledTimes(1);
  });

  it("intégration sans secret de webhook, ou numéro inconnu / d'une autre passerelle : le MÊME refus, rien d'enregistré", async () => {
    const s = store();
    const body = enc(received());
    expect((await run(body, { "x-webhook-signature": signHmacSha256Hex(SECRET, body) }, s, null)).kind).toBe("invalid_signature");
    const other = enc({ ...received(), phone_number_id: "111111111111111" });
    expect((await run(other, { "x-webhook-signature": signHmacSha256Hex(SECRET, other) }, s)).kind).toBe("invalid_signature");
    expect(s.record).not.toHaveBeenCalled();
  });

  it("l'adaptateur de Meta ne retrouve que les intégrations « meta »", async () => {
    const s = store();
    const body = enc({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: PHONE }, messages: [] } }] }] });
    await ingestWebhook({ adapter: whatsappWebhookAdapter, rawBody: body, headers: { "x-hub-signature-256": `sha256=${signHmacSha256Hex(SECRET, body)}` }, store: s, readSecret: async () => SECRET });
    expect(s.resolve).toHaveBeenCalledWith("whatsapp", PHONE, "meta");
  });
});

describe("envoi par Kapso", () => {
  const input = { kind: "text" as const, phoneNumberId: PHONE, to: "212600000001", text: "Bonjour" };

  it("adresse FIXE de Kapso, clé dans X-API-Key (jamais Bearer), corps identique à celui de Meta", async () => {
    const fetchMock = vi.fn(async () => json(200, { messages: [{ id: "wamid.OK1" }] }));
    const outcome = await createKapsoSender({ fetch: fetchMock as never }).send(input, KEY);
    expect(outcome).toEqual({ kind: "accepted", providerMessageId: "wamid.OK1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${KAPSO_BASE}/${PHONE}/messages`);
    const headers = init.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe(KEY);
    expect(headers.Authorization).toBeUndefined();
    expect(init.redirect).toBe("error");
    expect(JSON.parse(String(init.body))).toMatchObject({ messaging_product: "whatsapp", to: "212600000001", type: "text" });
    expect(url).not.toContain(KEY);
  });

  it("clé refusée : refus définitif ; panne : résultat inconnu (jamais renvoyé) ; limite : nouvel essai sûr ; texte du fournisseur jamais recopié", async () => {
    const sender = (response: () => Response) => createKapsoSender({ fetch: (async () => response()) as never });
    expect(await sender(() => json(401, { error: { message: `clé ${KEY} refusée` } })).send(input, KEY)).toEqual({ kind: "rejected", code: "provider_auth" });
    expect(await sender(() => json(503, {})).send(input, KEY)).toEqual({ kind: "unknown", code: "gateway_uncertain" });
    expect(await sender(() => json(429, {})).send(input, KEY)).toEqual({ kind: "retryable", code: "provider_rate_limited" });
    const refused = await sender(() => json(400, { error: { code: 100, message: `numéro ${PHONE} ${KEY}` } })).send(input, KEY);
    expect(JSON.stringify(refused)).not.toContain(KEY);
    expect(JSON.stringify(refused)).not.toContain(PHONE);
  });

  it("clé vide ou avec caractère de contrôle, numéro invalide : jamais envoyé", async () => {
    const fetchMock = vi.fn();
    const sender = createKapsoSender({ fetch: fetchMock as never });
    for (const key of ["", "cle\nsuite"]) expect(await sender.send(input, key)).toEqual({ kind: "rejected", code: "invalid_input" });
    expect(await sender.send({ ...input, phoneNumberId: "abc" }, KEY)).toEqual({ kind: "rejected", code: "invalid_input" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("le routeur envoie par Kapso pour « kapso » et par Meta sinon (défaut : Meta)", async () => {
    const meta = { name: "m", send: vi.fn(async () => ({ kind: "accepted" as const, providerMessageId: "meta" })) };
    const kapso = { name: "k", send: vi.fn(async () => ({ kind: "accepted" as const, providerMessageId: "kapso" })) };
    const router = createWhatsAppGatewaySender({ meta, kapso });
    expect(await router.send({ ...input, gateway: "kapso" }, KEY)).toMatchObject({ providerMessageId: "kapso" });
    expect(await router.send({ ...input, gateway: "meta" }, KEY)).toMatchObject({ providerMessageId: "meta" });
    expect(await router.send(input, KEY)).toMatchObject({ providerMessageId: "meta" });
    expect(meta.send).toHaveBeenCalledTimes(2);
  });

  it("l'envoi direct de Meta garde son adresse et son authentification Bearer", async () => {
    const fetchMock = vi.fn(async () => json(200, { messages: [{ id: "wamid.OK2" }] }));
    await createWhatsAppSender({ fetch: fetchMock as never }).send(input, "jeton-meta-0123456789");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("graph.facebook.com");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jeton-meta-0123456789");
  });
});

describe("vérification de la clé et du numéro Kapso", () => {
  it("clé acceptée : une requête GET vers l'adresse fixe, clé dans X-API-Key", async () => {
    const fetchMock = vi.fn(async () => json(200, { id: PHONE }));
    expect(await createKapsoClient({ fetch: fetchMock as never }).validate({ phoneNumberId: PHONE, accessToken: KEY })).toEqual({ kind: "valid" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${KAPSO_BASE}/${PHONE}?fields=id`);
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe(KEY);
  });

  it("clé refusée : provider_auth ; numéro inconnu : provider_account ; panne : provider_unavailable ; réponse d'un autre numéro : provider_unreadable", async () => {
    const run = (response: () => Response) => createKapsoClient({ fetch: (async () => response()) as never }).validate({ phoneNumberId: PHONE, accessToken: KEY });
    expect(await run(() => json(401, {}))).toEqual({ kind: "invalid", code: "provider_auth" });
    expect(await run(() => json(404, {}))).toEqual({ kind: "invalid", code: "provider_account" });
    expect(await run(() => json(503, {}))).toEqual({ kind: "invalid", code: "provider_unavailable" });
    expect(await run(() => json(200, { id: "999999999999" }))).toEqual({ kind: "invalid", code: "provider_unreadable" });
  });
});
