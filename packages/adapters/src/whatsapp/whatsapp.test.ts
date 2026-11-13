import { describe, expect, it } from "vitest";
import { signHmacSha256Hex } from "../webhooks/hmac";
import { answerWhatsAppChallenge, whatsappWebhookAdapter as adapter } from "./webhook";
import { createWhatsAppCloudClient, WHATSAPP_GRAPH_BASE } from "./cloud";

const PHONE = "106540352242922";
const SECRET = "app-secret-0123456789abcdef0123456789";
const body = (phone = PHONE, extra: Record<string, unknown> = {}) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "102290129340398", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550783881", phone_number_id: phone }, ...extra } }] }],
});
const raw = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const norm = (value: unknown) => adapter.parse(raw(value));
const msg = (id: string) => ({ from: "212600000000", id, timestamp: "1700000000", text: { body: "Bonjour" }, type: "text" });

describe("adaptateur de webhook WhatsApp", () => {
  it("lit le corps JSON ; un corps illisible ou non UTF-8 donne null, sans exception", () => {
    // la forme conservée est la forme NORMALISÉE (pas le corps brut)
    expect(adapter.parse(raw(body()))).toEqual({ object: "whatsapp_business_account", phoneNumberIds: [PHONE], events: [], skipped: 0 });
    expect(adapter.parse(new TextEncoder().encode("pas du json"))).toBeNull();
    expect(adapter.parse(new Uint8Array([0xff, 0xfe, 0x7b]))).toBeNull();
  });

  it("le compte est l'identifiant du numéro ; formes invalides, objet inattendu ou numéros mélangés : null", () => {
    expect(adapter.extractAccount(norm(body()), {})).toBe(PHONE);
    expect(adapter.extractAccount(norm(body("abc")), {})).toBeNull();
    expect(adapter.extractAccount(norm(body("1234")), {})).toBeNull();
    expect(adapter.extractAccount(norm({ ...body(), object: "page" }), {})).toBeNull();
    expect(adapter.extractAccount(norm({ object: "whatsapp_business_account", entry: [] }), {})).toBeNull();
    // notification sans numéro (état du compte) : acceptée si un autre changement désigne le numéro ; seule, elle ne désigne rien
    const status = { field: "account_update", value: { event: "VERIFIED_ACCOUNT" } };
    expect(adapter.extractAccount(norm({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [status, body().entry[0]?.changes[0]] }] }), {})).toBe(PHONE);
    expect(adapter.extractAccount(norm({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [status] }] }), {})).toBeNull();
    expect(adapter.extractAccount(null, {})).toBeNull();
    const mixed = { object: "whatsapp_business_account", entry: [body().entry[0], body("999999999999").entry[0]] };
    expect(adapter.extractAccount(norm(mixed), {})).toBeNull();
  });

  it("l'identifiant d'événement est stable pour un même corps (nouvel essai de Meta) et différent pour un autre", () => {
    const a = adapter.extractEventId(norm(body(PHONE, { messages: [msg("wamid.A")] })), {});
    expect(a).toMatch(/^wa:[0-9a-f]{40}$/);
    expect(adapter.extractEventId(norm(body(PHONE, { messages: [msg("wamid.A")] })), {})).toBe(a);
    expect(adapter.extractEventId(norm(body(PHONE, { messages: [msg("wamid.B")] })), {})).not.toBe(a);
    expect(adapter.extractEventId(norm({ object: "x" }), {})).toBeNull();
  });

  it("la signature X-Hub-Signature-256 est vérifiée sur le corps BRUT avec le secret de l'intégration", () => {
    const bytes = raw(body());
    const good = `sha256=${signHmacSha256Hex(SECRET, bytes)}`;
    expect(adapter.verify({ rawBody: bytes, headers: { "x-hub-signature-256": good }, secret: SECRET })).toBe(true);
    expect(adapter.verify({ rawBody: bytes, headers: { "x-hub-signature-256": good }, secret: `${SECRET}x` })).toBe(false);
    expect(adapter.verify({ rawBody: raw(body("999999999999")), headers: { "x-hub-signature-256": good }, secret: SECRET })).toBe(false);
    expect(adapter.verify({ rawBody: bytes, headers: { "x-hub-signature-256": signHmacSha256Hex(SECRET, bytes) }, secret: SECRET })).toBe(false);
    expect(adapter.verify({ rawBody: bytes, headers: {}, secret: SECRET })).toBe(false);
    expect(adapter.verify({ rawBody: bytes, headers: { "x-hub-signature-256": good }, secret: null })).toBe(false);
  });

  it("limite de taille : 3 Mo", () => {
    expect(adapter.maxBytes).toBe(3 * 1024 * 1024);
    expect(adapter.provider).toBe("whatsapp");
  });
});

describe("poignée de main d'abonnement (GET)", () => {
  const q = (o: Record<string, string>) => new URLSearchParams(o);
  const ok = { "hub.mode": "subscribe", "hub.verify_token": "jeton-plateforme-0123456789", "hub.challenge": "1158201444" };
  it("renvoie le défi quand le jeton de la plateforme est correct", () => {
    expect(answerWhatsAppChallenge(q(ok), "jeton-plateforme-0123456789")).toBe("1158201444");
  });
  it("refuse : mauvais jeton, mauvais mode, défi absent ou non sûr, jeton de la plateforme non configuré", () => {
    expect(answerWhatsAppChallenge(q({ ...ok, "hub.verify_token": "autre" }), "jeton-plateforme-0123456789")).toBeNull();
    expect(answerWhatsAppChallenge(q({ ...ok, "hub.mode": "unsubscribe" }), "jeton-plateforme-0123456789")).toBeNull();
    expect(answerWhatsAppChallenge(q({ "hub.mode": "subscribe", "hub.verify_token": ok["hub.verify_token"] }), "jeton-plateforme-0123456789")).toBeNull();
    expect(answerWhatsAppChallenge(q({ ...ok, "hub.challenge": "<script>alert(1)</script>" }), "jeton-plateforme-0123456789")).toBeNull();
    expect(answerWhatsAppChallenge(q(ok), undefined)).toBeNull();
    expect(answerWhatsAppChallenge(q(ok), "")).toBeNull();
  });
});

describe("validation de la connexion (API Graph)", () => {
  const TOKEN = "EAAG-SECRET-TOKEN-0123456789";
  const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  function fake(response: Response | Error) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (response instanceof Error) throw response;
      return response;
    }) as typeof fetch;
    return { fetch: impl, calls };
  }
  const run = (f: ReturnType<typeof fake>, phone = PHONE, token = TOKEN) => createWhatsAppCloudClient({ fetch: f.fetch }).validate({ phoneNumberId: phone, accessToken: token });

  it("valide : le jeton lit le numéro ; appelle QUE l'adresse fixe de Meta, jeton dans l'en-tête Authorization", async () => {
    const f = fake(json(200, { id: PHONE }));
    expect(await run(f)).toEqual({ kind: "valid" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(`${WHATSAPP_GRAPH_BASE}/${PHONE}?fields=id`);
    const init = f.calls[0]?.init as RequestInit & { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.redirect).toBe("error");
    expect(f.calls[0]?.url).not.toContain(TOKEN);
  });

  it("jeton refusé (401, 403, code 190) : provider_auth", async () => {
    expect(await run(fake(json(401, { error: { code: 190 } })))).toEqual({ kind: "invalid", code: "provider_auth" });
    expect(await run(fake(json(403, {})))).toEqual({ kind: "invalid", code: "provider_auth" });
    expect(await run(fake(json(400, { error: { code: 190, message: "Invalid OAuth access token" } })))).toEqual({ kind: "invalid", code: "provider_auth" });
  });

  it("numéro introuvable ou non autorisé (404, codes 100 et 33) : provider_account", async () => {
    expect(await run(fake(json(404, {})))).toEqual({ kind: "invalid", code: "provider_account" });
    expect(await run(fake(json(400, { error: { code: 100 } })))).toEqual({ kind: "invalid", code: "provider_account" });
    expect(await run(fake(json(400, { error: { code: 33 } })))).toEqual({ kind: "invalid", code: "provider_account" });
  });

  it("panne, limite ou coupure : provider_unavailable ; réponse inexploitable ou autre numéro : provider_unreadable", async () => {
    expect(await run(fake(json(500, {})))).toEqual({ kind: "invalid", code: "provider_unavailable" });
    expect(await run(fake(json(429, {})))).toEqual({ kind: "invalid", code: "provider_unavailable" });
    // limite de débit de Graph : HTTP 400 avec un code de limite = panne passagère, jamais une erreur de compte
    for (const code of [4, 17, 32, 613, 80007, 130429]) expect(await run(fake(json(400, { error: { code } })))).toEqual({ kind: "invalid", code: "provider_unavailable" });
    expect(await run(fake(new Error("réseau")))).toEqual({ kind: "invalid", code: "provider_unavailable" });
    expect(await run(fake(json(200, { id: "999999999" })))).toEqual({ kind: "invalid", code: "provider_unreadable" });
    expect(await run(fake(new Response("<html>", { status: 200 })))).toEqual({ kind: "invalid", code: "provider_unreadable" });
  });

  it("entrées invalides : aucun appel réseau (numéro non numérique, jeton vide, caractère de contrôle)", async () => {
    for (const [phone, token] of [["../etc", TOKEN], ["12", TOKEN], [PHONE, ""], [PHONE, "jeton\r\nX: y"]] as const) {
      const f = fake(json(200, { id: PHONE }));
      expect((await run(f, phone, token)).kind).toBe("invalid");
      expect(f.calls).toHaveLength(0);
    }
  });

  it("aucun texte du fournisseur ni jeton dans le résultat", async () => {
    const out = await run(fake(json(400, { error: { code: 100, message: `Unsupported get request ${PHONE} token ${TOKEN}` } })));
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(JSON.stringify(out)).not.toContain("Unsupported");
  });
});
