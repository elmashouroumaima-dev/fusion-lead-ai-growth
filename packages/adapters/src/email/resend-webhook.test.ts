import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ingestWebhook } from "../webhooks/ingest";
import type { WebhookStore } from "../webhooks/types";
import { readEmailEvent } from "./events";
import { normalizeResendPayload, resendAccountId, resendWebhookAdapter } from "./resend-webhook";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef");
const SECRET = `whsec_${KEY.toString("base64")}`;
const MSG = "11111111-2222-4333-8444-555555555555";
const REF = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const body = (type: string, data: Record<string, unknown> = {}) =>
  new TextEncoder().encode(JSON.stringify({ type, created_at: "2026-11-23T10:00:00.000Z", data: { email_id: MSG, from: "Acme <ventes@exemple.test>", to: ["Client@Exemple.test"], subject: "Bonjour", tags: { fusion_message_id: REF }, ...data } }));
const sign = (raw: Uint8Array, id = "msg_abc", ts = "1700000000", key: Buffer = KEY) =>
  `v1,${createHmac("sha256", key).update(Buffer.concat([Buffer.from(`${id}.${ts}.`), Buffer.from(raw)])).digest("base64")}`;
const headers = (raw: Uint8Array, over: Record<string, string> = {}) => ({ "svix-id": "msg_abc", "svix-timestamp": "1700000000", "svix-signature": sign(raw), ...over });

describe("resendWebhookAdapter.verify (signature Svix)", () => {
  const raw = body("email.delivered");
  it("accepte la bonne signature", () => {
    expect(resendWebhookAdapter.verify({ rawBody: raw, headers: headers(raw), secret: SECRET })).toBe(true);
  });
  it("accepte une rotation : une signature parmi plusieurs", () => {
    const other = sign(raw, "msg_abc", "1700000000", Buffer.from("autre-cle-autre-cle-autre-cle-00"));
    expect(resendWebhookAdapter.verify({ rawBody: raw, headers: headers(raw, { "svix-signature": `${other} ${sign(raw)}` }), secret: SECRET })).toBe(true);
  });
  it.each([
    ["corps modifié", (r: Uint8Array) => ({ raw: new TextEncoder().encode(new TextDecoder().decode(r) + " "), h: headers(r) })],
    ["identifiant modifié", (r: Uint8Array) => ({ raw: r, h: headers(r, { "svix-id": "msg_autre" }) })],
    ["horodatage modifié", (r: Uint8Array) => ({ raw: r, h: headers(r, { "svix-timestamp": "1700000001" }) })],
    ["signature absente", (r: Uint8Array) => ({ raw: r, h: { "svix-id": "msg_abc", "svix-timestamp": "1700000000" } })],
    ["signature mal formée", (r: Uint8Array) => ({ raw: r, h: headers(r, { "svix-signature": "v2,AAAA" }) })],
  ])("refuse : %s", (_l, build) => {
    const { raw: r, h } = build(raw);
    expect(resendWebhookAdapter.verify({ rawBody: r, headers: h, secret: SECRET })).toBe(false);
  });
  it("refuse sans secret, ou avec un secret qui n'a pas la forme whsec_<base64>", () => {
    expect(resendWebhookAdapter.verify({ rawBody: raw, headers: headers(raw), secret: null })).toBe(false);
    expect(resendWebhookAdapter.verify({ rawBody: raw, headers: headers(raw), secret: KEY.toString("base64") })).toBe(false);
    expect(resendWebhookAdapter.verify({ rawBody: raw, headers: headers(raw), secret: "whsec_!!!" })).toBe(false);
  });
  it("refuse la signature d'un autre secret", () => {
    const wrong = sign(raw, "msg_abc", "1700000000", Buffer.from("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"));
    expect(resendWebhookAdapter.verify({ rawBody: raw, headers: headers(raw, { "svix-signature": wrong }), secret: SECRET })).toBe(false);
  });
});

describe("resendWebhookAdapter : lecture", () => {
  it("fournisseur, stockage et passerelle", () => {
    expect(resendWebhookAdapter).toMatchObject({ provider: "resend", storeProvider: "email", gateway: "resend" });
  });
  it("delivered : compte tiré du domaine de l'expéditeur, identifiant du message, étiquette de notre message", () => {
    const parsed = resendWebhookAdapter.parse(body("email.delivered"));
    expect(resendWebhookAdapter.extractAccount(parsed, {})).toBe("resend-exemple.test");
    expect(readEmailEvent(parsed)).toMatchObject({ kind: "delivered", providerMessageId: MSG, recipient: "client@exemple.test", ref: REF, at: "2026-11-23T10:00:00.000Z" });
    expect(resendWebhookAdapter.extractEventId(parsed, {})).toMatch(/^rs-del:/);
  });
  it("même corps = même identifiant (déduplication des retries) ; autre date = autre identifiant", () => {
    const a = resendWebhookAdapter.extractEventId(resendWebhookAdapter.parse(body("email.delivered")), {});
    const b = resendWebhookAdapter.extractEventId(resendWebhookAdapter.parse(body("email.delivered")), {});
    expect(a).toBe(b);
    const later = new TextEncoder().encode(new TextDecoder().decode(body("email.delivered")).replace("10:00:00", "11:00:00"));
    expect(resendWebhookAdapter.extractEventId(resendWebhookAdapter.parse(later), {})).not.toBe(a);
  });
  it("rebond dur seulement si le fournisseur dit « Permanent »", () => {
    expect(readEmailEvent(resendWebhookAdapter.parse(body("email.bounced", { bounce: { type: "Permanent" } })))).toMatchObject({ kind: "bounced", hard: true });
    expect(readEmailEvent(resendWebhookAdapter.parse(body("email.bounced", { bounce: { type: "Transient" } })))).toMatchObject({ kind: "bounced", hard: false });
    expect(readEmailEvent(resendWebhookAdapter.parse(body("email.bounced")))).toMatchObject({ kind: "bounced", hard: false });
  });
  it("plainte", () => {
    expect(readEmailEvent(resendWebhookAdapter.parse(body("email.complained")))).toMatchObject({ kind: "complaint", providerMessageId: MSG });
  });
  it("étiquette invalide : pas de référence, l'événement reste utilisable par l'identifiant du fournisseur", () => {
    expect(readEmailEvent(resendWebhookAdapter.parse(body("email.delivered", { tags: { fusion_message_id: "pas-un-uuid" } })))).toMatchObject({ ref: null });
  });
  it("autre événement d'e-mail : acquitté et ignoré, avec son compte", () => {
    const parsed = resendWebhookAdapter.parse(body("email.opened"));
    expect(readEmailEvent(parsed)).toMatchObject({ kind: "ignored", recordType: "emailopened" });
    expect(resendWebhookAdapter.extractAccount(parsed, {})).toBe("resend-exemple.test");
  });
  it.each([["pas du JSON", "x{"], ["delivered sans identifiant", JSON.stringify({ type: "email.delivered", data: { from: "a@b.test", to: ["c@d.test"] } })], ["delivered sans destinataire valide", JSON.stringify({ type: "email.delivered", data: { email_id: MSG, from: "a@b.test", to: ["pas une adresse"] } })], ["tableau", "[]"]])(
    "illisible : %s",
    (_l, text) => {
      expect(resendWebhookAdapter.parse(new TextEncoder().encode(text))).toBeNull();
    },
  );
  it("S-06 : événement qui n'est pas d'e-mail (domaine, contact) : ignoré et acquitté, jamais refusé", async () => {
    const parsed = resendWebhookAdapter.parse(new TextEncoder().encode(JSON.stringify({ type: "domain.updated", created_at: "2026-11-24T10:00:00Z", data: { id: "d" } })));
    expect(parsed).toMatchObject({ kind: "ignored", account: null });
    expect(resendWebhookAdapter.isIrrelevant?.(parsed, {})).toBe(true);
    const store: WebhookStore = { resolve: vi.fn(async () => []), record: vi.fn(async () => { throw new Error("jamais"); }), recordRejection: vi.fn(async () => undefined) };
    const raw = new TextEncoder().encode(JSON.stringify({ type: "contact.created", data: {} }));
    expect(await ingestWebhook({ adapter: resendWebhookAdapter, rawBody: raw, headers: {}, store, readSecret: async () => null })).toEqual({ kind: "ignored" });
    expect(store.resolve).not.toHaveBeenCalled();
    expect(store.record).not.toHaveBeenCalled();
  });
  it("S-06 : événement d'e-mail sans expéditeur lisible : ignoré aussi (rien à résoudre) ; corps qui n'est pas du JSON : toujours 400", async () => {
    const raw = body("email.delivered", { from: undefined });
    const store: WebhookStore = { resolve: vi.fn(async () => []), record: vi.fn(), recordRejection: vi.fn() };
    expect(await ingestWebhook({ adapter: resendWebhookAdapter, rawBody: raw, headers: {}, store, readSecret: async () => null })).toEqual({ kind: "ignored" });
    expect(await ingestWebhook({ adapter: resendWebhookAdapter, rawBody: new TextEncoder().encode("x{"), headers: {}, store, readSecret: async () => null })).toEqual({ kind: "bad_request" });
  });
  it("sans expéditeur lisible : pas de compte (le pipeline acquitte sans écriture, S-06)", () => {
    const parsed = resendWebhookAdapter.parse(body("email.delivered", { from: undefined }));
    expect(resendWebhookAdapter.extractAccount(parsed, {})).toBeNull();
  });
  it("horodatage : lu dans svix-timestamp (signé), sinon null", () => {
    expect(resendWebhookAdapter.extractTimestamp?.(null, { "svix-timestamp": "1700000000" })).toBe(1700000000);
    expect(resendWebhookAdapter.extractTimestamp?.(null, { "svix-timestamp": "abc" })).toBeNull();
    expect(resendWebhookAdapter.extractTimestamp?.(null, {})).toBeNull();
  });
  it("corps trop gros : plafond de 1 Mo", () => {
    expect(resendWebhookAdapter.maxBytes).toBe(1024 * 1024);
  });
});

describe("email.received (réception)", () => {
  const received = (data: Record<string, unknown> = {}) =>
    new TextEncoder().encode(JSON.stringify({ type: "email.received", created_at: "2026-11-24T10:00:00.000Z", data: { email_id: MSG, from: "Client <c@client.test>", to: ["ventes@exemple.test"], received_for: ["Ventes@Exemple.test"], subject: "Re", message_id: "<m@x>", ...data } }));
  it("événement à relire par l'API : seulement l'identifiant ; compte = domaine de l'adresse qui a REÇU (pas du client)", () => {
    const parsed = resendWebhookAdapter.parse(received());
    expect(resendWebhookAdapter.extractAccount(parsed, {})).toBe("resend-exemple.test");
    expect(readEmailEvent(parsed)).toEqual({ kind: "inbound_fetch", eventId: `rs-rcv:${MSG}`, emailId: MSG, at: "2026-11-24T10:00:00.000Z" });
    expect(resendWebhookAdapter.extractEventId(parsed, {})).toBe(`rs-rcv:${MSG}`);
  });
  it("sans received_for : repli sur to ; sans destinataire lisible ou sans identifiant : illisible", () => {
    expect(resendWebhookAdapter.extractAccount(resendWebhookAdapter.parse(received({ received_for: undefined })), {})).toBe("resend-exemple.test");
    expect(resendWebhookAdapter.parse(received({ received_for: [], to: [] }))).toBeNull();
    expect(resendWebhookAdapter.parse(received({ email_id: undefined }))).toBeNull();
  });
  it("le corps éventuel du webhook n'est jamais conservé", () => {
    const parsed = resendWebhookAdapter.parse(received({ text: "SECRET", html: "<b>SECRET</b>" }));
    expect(JSON.stringify(parsed)).not.toContain("SECRET");
  });
});

describe("resendAccountId", () => {
  it("domaine de l'expéditeur, en minuscules, caractères permis seulement", () => {
    expect(resendAccountId("Ventes@Exemple.TEST")).toBe("resend-exemple.test");
    expect(resendAccountId("a@b c.test")).toBe("resend-b-c.test");
  });
  it("même résultat que l'identifiant de l'écran de connexion", () => {
    expect(normalizeResendPayload({ type: "email.sent", created_at: "2026-11-23T10:00:00Z", data: { from: "onboarding@resend.dev" } })?.account).toBe("resend-resend.dev");
  });
});

describe("résolution par la passerelle et pipeline complet", () => {
  const raw = body("email.delivered");
  const store = (found: boolean): WebhookStore => ({
    resolve: vi.fn(async () => (found ? [{ organizationId: "org-1", integrationId: "int-1" }] : [])),
    record: vi.fn(async () => ({ eventId: "e1", duplicate: false })),
    recordRejection: vi.fn(async () => undefined),
  });
  const run = (st: WebhookStore, over: Record<string, string> = {}, secret: string | null = SECRET) =>
    ingestWebhook({ adapter: resendWebhookAdapter, rawBody: raw, headers: headers(raw, over), store: st, readSecret: async () => secret, now: () => 1_700_000_100 });

  it("signature valide : acceptée, retrouvée sous « email » avec la passerelle « resend »", async () => {
    const st = store(true);
    expect(await run(st)).toEqual({ kind: "accepted", eventId: "e1" });
    expect(st.resolve).toHaveBeenCalledWith("email", "resend-exemple.test", "resend");
  });
  it("horodatage hors fenêtre de 5 minutes : refusé et rejet enregistré", async () => {
    const st = store(true);
    const old = headers(raw, { "svix-timestamp": "1699990000", "svix-signature": sign(raw, "msg_abc", "1699990000") });
    expect(await ingestWebhook({ adapter: resendWebhookAdapter, rawBody: raw, headers: old, store: st, readSecret: async () => SECRET, now: () => 1_700_000_100 })).toEqual({ kind: "invalid_signature" });
    expect(st.record).not.toHaveBeenCalled();
    expect(st.recordRejection).toHaveBeenCalled();
  });
  it("compte inconnu ou mauvais secret : même réponse, rien n'est enregistré", async () => {
    expect(await run(store(false))).toEqual({ kind: "invalid_signature" });
    const st = store(true);
    expect(await run(st, {}, `whsec_${Buffer.from("un-autre-secret-un-autre-secret-0").toString("base64")}`)).toEqual({ kind: "invalid_signature" });
    expect(st.record).not.toHaveBeenCalled();
  });
});
