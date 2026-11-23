import { describe, expect, it, vi } from "vitest";
import { createResendValidator, RESEND_DOMAINS_URL } from "./resend-validate";
import { createEmailGatewayProvider } from "./gateway";

const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
const run = (status: number, body: unknown) => createResendValidator({ fetch: reply(status, body) as unknown as typeof fetch }).validate({ apiKey: "re_x" });

describe("createResendValidator", () => {
  it("appelle l'adresse fixe avec le jeton en Bearer", async () => {
    const f = reply(200, { data: [] });
    expect(await createResendValidator({ fetch: f as unknown as typeof fetch }).validate({ apiKey: "re_x" })).toEqual({ kind: "valid" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RESEND_DOMAINS_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_x");
  });
  it("clé limitée à l'envoi (401 restricted_api_key) = valide", async () => {
    expect(await run(401, { name: "restricted_api_key" })).toEqual({ kind: "valid" });
  });
  it.each([
    [401, { name: "validation_error" }, "provider_auth"],
    [403, { name: "restricted_api_key" }, "provider_auth"],
    [429, { name: "rate_limit_exceeded" }, "provider_unavailable"],
    [503, null, "provider_unavailable"],
    [418, null, "provider_unreadable"],
  ])("statut %i %j -> %s", async (status, body, code) => {
    expect(await run(status, body)).toEqual({ kind: "invalid", code });
  });
  it("jeton vide ou non imprimable : aucun appel réseau", async () => {
    const f = reply(200, {});
    const v = createResendValidator({ fetch: f as unknown as typeof fetch });
    expect(await v.validate({ apiKey: "" })).toEqual({ kind: "invalid", code: "provider_auth" });
    expect(await v.validate({ apiKey: "re_\n" })).toEqual({ kind: "invalid", code: "provider_auth" });
    expect(f).not.toHaveBeenCalled();
  });
  it("panne réseau = provider_unavailable", async () => {
    const boom = vi.fn(async () => { throw new Error("x"); });
    expect(await createResendValidator({ fetch: boom as unknown as typeof fetch }).validate({ apiKey: "re_x" })).toEqual({ kind: "invalid", code: "provider_unavailable" });
  });
});

describe("createEmailGatewayProvider", () => {
  const mk = (name: string) => ({ name, send: vi.fn(async () => ({ kind: "accepted" as const, providerMessageId: name })) });
  const input = { from: "a@b.test", to: "c@d.test", subject: "s", textBody: "t" };
  it("Postmark par défaut ou si gateway = postmark ; Resend seulement si gateway = resend", async () => {
    const postmark = mk("postmark");
    const resend = mk("resend");
    const router = createEmailGatewayProvider({ postmark, resend });
    expect(await router.send(input, "k")).toMatchObject({ providerMessageId: "postmark" });
    expect(await router.send({ ...input, gateway: "postmark" }, "k")).toMatchObject({ providerMessageId: "postmark" });
    expect(await router.send({ ...input, gateway: "resend" }, "k")).toMatchObject({ providerMessageId: "resend" });
    expect(postmark.send).toHaveBeenCalledTimes(2);
    expect(resend.send).toHaveBeenCalledTimes(1);
  });
});
