import { describe, expect, it, vi } from "vitest";
import { createResendProvider, RESEND_ENDPOINT } from "./resend";

const SECRET = "re_test_token";
const input = { from: "ventes@example.test", to: "client@example.test", subject: "Bonjour", textBody: "Texte", metadata: { message_id: "m-1" } };
const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("createResendProvider", () => {
  it("envoie sur l'adresse fixe avec le jeton en Bearer et renvoie l'identifiant", async () => {
    const fetchMock = reply(200, { id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" });
    const out = await createResendProvider({ fetch: fetchMock as unknown as typeof fetch }).send(
      { ...input, headers: [{ name: "List-Unsubscribe", value: "<https://x.test/u>" }] }, SECRET,
    );
    expect(out).toEqual({ kind: "accepted", providerMessageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RESEND_ENDPOINT);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body as string)).toEqual({
      from: input.from, to: input.to, subject: input.subject, text: input.textBody,
      tags: [{ name: "message_id", value: "m-1" }], headers: { "List-Unsubscribe": "<https://x.test/u>" },
    });
  });

  it.each([
    ["from invalide", { ...input, from: "pas une adresse" }],
    ["objet avec saut de ligne", { ...input, subject: "a\nb" }],
    ["étiquette hors jeu de caractères (point)", { ...input, metadata: { message_id: "a.b" } }],
    ["en-tête hors liste blanche", { ...input, headers: [{ name: "Bcc", value: "x@y.test" }] }],
  ])("refuse localement : %s", async (_label, bad) => {
    const fetchMock = reply(200, { id: "x" });
    expect(await createResendProvider({ fetch: fetchMock as unknown as typeof fetch }).send(bad, SECRET)).toEqual({ kind: "rejected", code: "invalid_input" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuse un jeton vide ou avec caractère de contrôle sans appeler le réseau", async () => {
    const fetchMock = reply(200, { id: "x" });
    const p = createResendProvider({ fetch: fetchMock as unknown as typeof fetch });
    expect((await p.send(input, "")).kind).toBe("rejected");
    expect((await p.send(input, "re_a\nb")).kind).toBe("rejected");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, { name: "missing_api_key" }, { kind: "rejected", code: "provider_auth" }],
    [403, { name: "validation_error", message: "You can only send testing emails to c@d.test" }, { kind: "rejected", code: "sender_not_allowed" }],
    [403, { name: "suspended_api_key" }, { kind: "rejected", code: "provider_auth" }],
    [403, { name: "email_above_quota" }, { kind: "rejected", code: "provider_quota" }],
    [422, { name: "invalid_parameter" }, { kind: "rejected", code: "provider_rejected" }],
    [429, { name: "rate_limit_exceeded" }, { kind: "retryable", code: "provider_rate_limited" }],
    [429, { name: "daily_quota_exceeded" }, { kind: "rejected", code: "provider_quota" }],
    [503, { name: "service_unavailable" }, { kind: "retryable", code: "provider_unavailable" }],
    [500, { name: "application_error" }, { kind: "unknown", code: "gateway_uncertain" }],
    [502, null, { kind: "unknown", code: "gateway_uncertain" }],
  ])("statut %i %j", async (status, body, expected) => {
    expect(await createResendProvider({ fetch: reply(status, body) as unknown as typeof fetch }).send(input, SECRET)).toEqual(expected);
  });

  it("200 sans identifiant lisible = unknown (jamais renvoyé)", async () => {
    expect(await createResendProvider({ fetch: reply(200, {}) as unknown as typeof fetch }).send(input, SECRET)).toEqual({ kind: "unknown", code: "unreadable_response" });
  });

  it("aucune réponse (coupure/délai) = unknown ; le texte d'erreur ne contient ni jeton ni destinataire", async () => {
    const boom = vi.fn(async () => { throw new Error(`fail ${SECRET} client@example.test`); });
    const out = await createResendProvider({ fetch: boom as unknown as typeof fetch }).send(input, SECRET);
    expect(out).toEqual({ kind: "unknown", code: "no_response" });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
});
