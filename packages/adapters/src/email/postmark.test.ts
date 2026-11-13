import { describe, expect, it } from "vitest";
import { createPostmarkProvider, POSTMARK_ENDPOINT } from "./postmark";

const input = { from: "ventes@acme.test", to: "karim@example.test", subject: "Bonjour", textBody: "Corps du message" };
const TOKEN = "tok-SECRET-0123456789";

type Call = { url: string; init: RequestInit };
function fake(response: Response | Error): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;
  return { fetch: impl, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("fournisseur Postmark", () => {
  it("accepte : renvoie l'identifiant du fournisseur (accepté n'est pas livré)", async () => {
    const f = fake(json(200, { ErrorCode: 0, Message: "OK", MessageID: "b7bc2f4a-e38e-4336-af7d-e6c392c2f817", To: "karim@example.test" }));
    const out = await createPostmarkProvider({ fetch: f.fetch }).send(input, TOKEN);
    expect(out).toEqual({ kind: "accepted", providerMessageId: "b7bc2f4a-e38e-4336-af7d-e6c392c2f817" });
  });

  it("n'appelle QUE l'adresse fixe, avec le jeton dans l'en-tête et le corps attendu", async () => {
    const f = fake(json(200, { ErrorCode: 0, MessageID: "id-1" }));
    await createPostmarkProvider({ fetch: f.fetch }).send(input, TOKEN);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(POSTMARK_ENDPOINT);
    const init = f.calls[0]?.init as RequestInit & { headers: Record<string, string> };
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers["X-Postmark-Server-Token"]).toBe(TOKEN);
    expect(JSON.parse(String(init.body))).toEqual({ From: input.from, To: input.to, Subject: input.subject, TextBody: input.textBody, MessageStream: "outbound" });
  });

  it("transmet les en-têtes de désabonnement sous la forme attendue par Postmark", async () => {
    const f = fake(json(200, { ErrorCode: 0, MessageID: "id-1" }));
    const headers = [{ name: "List-Unsubscribe", value: "<https://app.acme.test/unsubscribe/t>" }, { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" }];
    await createPostmarkProvider({ fetch: f.fetch }).send({ ...input, headers }, TOKEN);
    const sent = JSON.parse(String((f.calls[0]?.init as RequestInit).body)) as { Headers?: unknown };
    expect(sent.Headers).toEqual([{ Name: "List-Unsubscribe", Value: "<https://app.acme.test/unsubscribe/t>" }, { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" }]);
  });

  it("refuse un en-tête hors liste blanche ou avec saut de ligne, sans appel réseau", async () => {
    for (const headers of [[{ name: "Bcc", value: "x@y.test" }], [{ name: "List-Unsubscribe", value: "<a>\r\nBcc: x@y.test" }]]) {
      const f = fake(json(200, { ErrorCode: 0, MessageID: "id-1" }));
      expect(await createPostmarkProvider({ fetch: f.fetch }).send({ ...input, headers }, TOKEN)).toEqual({ kind: "rejected", code: "invalid_input" });
      expect(f.calls).toHaveLength(0);
    }
  });

  it("refus définitifs : jeton, adresse inactive, adresse invalide, autre refus", async () => {
    const run = async (r: Response) => createPostmarkProvider({ fetch: fake(r).fetch }).send(input, TOKEN);
    expect(await run(json(401, { ErrorCode: 10, Message: "Bad token" }))).toEqual({ kind: "rejected", code: "provider_auth" });
    expect(await run(json(422, { ErrorCode: 406, Message: "inactive" }))).toEqual({ kind: "rejected", code: "recipient_inactive" });
    expect(await run(json(422, { ErrorCode: 300, Message: "invalid" }))).toEqual({ kind: "rejected", code: "recipient_invalid" });
    expect(await run(json(422, { ErrorCode: 999 }))).toEqual({ kind: "rejected", code: "provider_rejected" });
    expect(await run(json(400, {}))).toEqual({ kind: "rejected", code: "provider_rejected" });
  });

  it("réponse « non accepté » (limite, panne) : réessayable sans risque de doublon", async () => {
    const run = async (r: Response) => createPostmarkProvider({ fetch: fake(r).fetch }).send(input, TOKEN);
    expect(await run(json(429, {}))).toEqual({ kind: "retryable", code: "provider_rate_limited" });
    expect(await run(json(500, {}))).toEqual({ kind: "retryable", code: "provider_unavailable" });
    expect(await run(json(503, {}))).toEqual({ kind: "retryable", code: "provider_unavailable" });
  });

  it("502, 504 et autres 5xx de passerelle : résultat inconnu (peut-être accepté), jamais renvoyé", async () => {
    const run = async (r: Response) => createPostmarkProvider({ fetch: fake(r).fetch }).send(input, TOKEN);
    for (const status of [502, 504, 520]) expect(await run(json(status, {}))).toEqual({ kind: "unknown", code: "gateway_uncertain" });
  });

  it("aucune réponse (coupure, délai) : résultat inconnu, à ne JAMAIS renvoyer", async () => {
    const out = await createPostmarkProvider({ fetch: fake(new TypeError("fetch failed")).fetch }).send(input, TOKEN);
    expect(out).toEqual({ kind: "unknown", code: "no_response" });
  });

  it("200 illisible ou sans identifiant valide : inconnu (le message est peut-être parti)", async () => {
    const run = async (r: Response) => createPostmarkProvider({ fetch: fake(r).fetch }).send(input, TOKEN);
    expect(await run(new Response("pas du json", { status: 200 }))).toEqual({ kind: "unknown", code: "unreadable_response" });
    expect(await run(json(200, { ErrorCode: 0 }))).toEqual({ kind: "unknown", code: "unreadable_response" });
    expect(await run(json(200, { ErrorCode: 0, MessageID: "id avec espace" }))).toEqual({ kind: "unknown", code: "unreadable_response" });
    expect(await run(json(200, { ErrorCode: 5, MessageID: "id-ok" }))).toEqual({ kind: "unknown", code: "unreadable_response" });
  });

  it("une réponse énorme n'est pas lue en entier", async () => {
    const huge = new Response("x".repeat(200_000), { status: 200 });
    const out = await createPostmarkProvider({ fetch: fake(huge).fetch }).send(input, TOKEN);
    expect(out).toEqual({ kind: "unknown", code: "unreadable_response" });
  });

  it("entrées invalides refusées SANS appel réseau (injection d'en-tête, adresse, objet, jeton)", async () => {
    const bad = [
      { ...input, to: "a@b.test\r\nBcc: autre@x.test" },
      { ...input, to: "pas-une-adresse" },
      { ...input, from: "" },
      { ...input, subject: "Objet\r\nBcc: x@y.test" },
      { ...input, subject: "" },
      { ...input, textBody: "" },
    ];
    for (const candidate of bad) {
      const f = fake(json(200, { ErrorCode: 0, MessageID: "id-1" }));
      expect(await createPostmarkProvider({ fetch: f.fetch }).send(candidate, TOKEN)).toEqual({ kind: "rejected", code: "invalid_input" });
      expect(f.calls).toHaveLength(0);
    }
    for (const badSecret of ["", "tok\r\nX-Injected: 1", "jeton-é-accentué", "x".repeat(201)]) {
      const f = fake(json(200, { ErrorCode: 0, MessageID: "id-1" }));
      expect(await createPostmarkProvider({ fetch: f.fetch }).send(input, badSecret)).toEqual({ kind: "rejected", code: "invalid_input" });
      expect(f.calls).toHaveLength(0);
    }
  });

  it("ni le jeton, ni l'adresse, ni le texte du fournisseur ne sortent dans un résultat", async () => {
    const outcomes = await Promise.all([
      createPostmarkProvider({ fetch: fake(json(422, { ErrorCode: 406, Message: "karim@example.test is inactive" })).fetch }).send(input, TOKEN),
      createPostmarkProvider({ fetch: fake(json(401, { Message: TOKEN })).fetch }).send(input, TOKEN),
      createPostmarkProvider({ fetch: fake(new Error(`boom ${TOKEN} karim@example.test`)).fetch }).send(input, TOKEN),
    ]);
    const text = JSON.stringify(outcomes);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("karim@example.test");
    expect(text).not.toContain("is inactive");
  });

  it("le délai est borné (signal d'annulation transmis)", async () => {
    const f = fake(json(200, { ErrorCode: 0, MessageID: "id-1" }));
    await createPostmarkProvider({ fetch: f.fetch, timeoutMs: 5000 }).send(input, TOKEN);
    expect((f.calls[0]?.init.signal as AbortSignal | undefined) instanceof AbortSignal).toBe(true);
  });
});
