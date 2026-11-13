import { describe, expect, it } from "vitest";
import { createWhatsAppSender, WHATSAPP_MESSAGES_BASE, type WhatsAppSendInput } from "./send";
import { createWhatsAppTemplateClient, parseMessageTemplates } from "./templates";

const PHONE = "106540352242922";
const TOKEN = "EAAG-SECRET-TOKEN-0123456789";
const text: WhatsAppSendInput = { kind: "text", phoneNumberId: PHONE, to: "212600000001", text: "Bonjour" };
const template: WhatsAppSendInput = { kind: "template", phoneNumberId: PHONE, to: "212600000001", template: { name: "offre_ete", language: "fr", variables: ["Nadia", "20 %"] } };
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
const run = (f: ReturnType<typeof fake>, input: WhatsAppSendInput = text, token = TOKEN) => createWhatsAppSender({ fetch: f.fetch }).send(input, token);

describe("envoi WhatsApp (API Cloud)", () => {
  it("texte : accepté avec l'identifiant wamid ; adresse fixe, jeton en en-tête, corps attendu", async () => {
    const f = fake(json(200, { messaging_product: "whatsapp", contacts: [{ input: "212600000001", wa_id: "212600000001" }], messages: [{ id: "wamid.HBgLMjEyNjAwMDAwMDAVAgARGBI" }] }));
    expect(await run(f)).toEqual({ kind: "accepted", providerMessageId: "wamid.HBgLMjEyNjAwMDAwMDAVAgARGBI" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(`${WHATSAPP_MESSAGES_BASE}/${PHONE}/messages`);
    const init = f.calls[0]?.init as RequestInit & { headers: Record<string, string> };
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init.body))).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to: "212600000001", type: "text", text: { preview_url: false, body: "Bonjour" } });
    expect(f.calls[0]?.url).not.toContain(TOKEN);
  });

  it("modèle : nom, langue et variables dans les composants du corps", async () => {
    const f = fake(json(200, { messages: [{ id: "wamid.T1" }] }));
    expect((await run(f, template)).kind).toBe("accepted");
    expect(JSON.parse(String((f.calls[0]?.init as RequestInit).body))).toEqual({
      messaging_product: "whatsapp", recipient_type: "individual", to: "212600000001", type: "template",
      template: { name: "offre_ete", language: { code: "fr" }, components: [{ type: "body", parameters: [{ type: "text", text: "Nadia" }, { type: "text", text: "20 %" }] }] },
    });
    const none = fake(json(200, { messages: [{ id: "wamid.T2" }] }));
    await run(none, { ...template, template: { ...template.template, variables: [] } } as WhatsAppSendInput);
    expect(JSON.parse(String((none.calls[0]?.init as RequestInit).body)).template.components).toBeUndefined();
  });

  it("refus définitifs : jeton, fenêtre fermée (131047), destinataire invalide, modèle invalide, autre refus", async () => {
    const out = async (status: number, code: number) => run(fake(json(status, { error: { code, message: "Texte de Meta avec 212600000001" } })));
    expect(await out(401, 190)).toEqual({ kind: "rejected", code: "provider_auth" });
    expect(await out(400, 190)).toEqual({ kind: "rejected", code: "provider_auth" });
    expect(await out(400, 131047)).toEqual({ kind: "rejected", code: "window_closed" });
    expect(await out(400, 131026)).toEqual({ kind: "rejected", code: "recipient_invalid" });
    expect(await out(400, 132001)).toEqual({ kind: "rejected", code: "template_invalid" });
    expect(await out(400, 999999)).toEqual({ kind: "rejected", code: "provider_rejected" });
  });

  it("limites et pannes annoncées (429, 500, 503, codes de limite en 400) : réessayable, un nouvel essai est sûr", async () => {
    expect(await run(fake(json(429, {})))).toEqual({ kind: "retryable", code: "provider_rate_limited" });
    for (const code of [4, 17, 80007, 130429, 131056]) expect(await run(fake(json(400, { error: { code } })))).toEqual({ kind: "retryable", code: "provider_rate_limited" });
  });

  it("résultat INCONNU (jamais renvoyé à l'aveugle) : coupure, 500, 502, 503, 504, erreurs internes 1 et 2, 200 sans identifiant lisible", async () => {
    for (const status of [500, 503]) expect(await run(fake(json(status, {})))).toEqual({ kind: "unknown", code: "gateway_uncertain" });
    for (const code of [1, 2]) expect(await run(fake(json(400, { error: { code } })))).toEqual({ kind: "unknown", code: "gateway_uncertain" });
    expect(await run(fake(new Error("réseau")))).toEqual({ kind: "unknown", code: "no_response" });
    expect(await run(fake(json(502, {})))).toEqual({ kind: "unknown", code: "gateway_uncertain" });
    expect(await run(fake(json(504, {})))).toEqual({ kind: "unknown", code: "gateway_uncertain" });
    expect(await run(fake(json(200, { messages: [] })))).toEqual({ kind: "unknown", code: "unreadable_response" });
    expect(await run(fake(json(200, { messages: [{ id: "pas valide !" }] })))).toEqual({ kind: "unknown", code: "unreadable_response" });
    expect(await run(fake(new Response("<html>", { status: 200 })))).toEqual({ kind: "unknown", code: "unreadable_response" });
  });

  it("entrées invalides : aucun appel réseau (numéro, destinataire, jeton, texte, nom ou langue de modèle, variables)", async () => {
    const bad: Array<[WhatsAppSendInput, string]> = [
      [{ ...text, phoneNumberId: "../etc" }, TOKEN], [{ ...text, to: "+212600000001" }, TOKEN], [text, ""], [text, "jeton\r\nX: y"],
      [{ ...text, text: "" }, TOKEN], [{ ...text, text: "a".repeat(4097) }, TOKEN], [{ ...text, text: "a\u0000b" }, TOKEN], [{ ...template, template: { ...template.template, variables: ["ligne 1\nligne 2"] } } as WhatsAppSendInput, TOKEN],
      [{ ...template, template: { ...template.template, name: "Offre Été" } } as WhatsAppSendInput, TOKEN],
      [{ ...template, template: { ...template.template, language: "francais" } } as WhatsAppSendInput, TOKEN],
      [{ ...template, template: { ...template.template, variables: Array.from({ length: 11 }, () => "x") } } as WhatsAppSendInput, TOKEN],
    ];
    for (const [input, token] of bad) {
      const f = fake(json(200, { messages: [{ id: "wamid.X" }] }));
      expect(await run(f, input, token)).toEqual({ kind: "rejected", code: "invalid_input" });
      expect(f.calls).toHaveLength(0);
    }
  });

  it("aucun texte de Meta, numéro ni jeton dans les résultats", async () => {
    const out = await run(fake(json(400, { error: { code: 100, message: `Invalid ${TOKEN} 212600000001` } })));
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(JSON.stringify(out)).not.toContain("212600000001");
  });
});

describe("modèles de message (liste Meta)", () => {
  const WABA = "102290129340398";
  const list = (data: unknown[]) => json(200, { data, paging: { cursors: {} } });
  const tpl = (patch: Record<string, unknown> = {}) => ({ name: "offre_ete", language: "fr", category: "MARKETING", status: "APPROVED", id: "1", components: [{ type: "BODY", text: "Bonjour {{1}}", example: { body_text: [["Nadia"]] } }], ...patch });
  const run2 = (r: Response | Error) => createWhatsAppTemplateClient({ fetch: fake(r).fetch }).list({ wabaId: WABA, accessToken: TOKEN });

  it("réduit la réponse aux champs utiles : catégorie et statut ramenés à nos valeurs, composants sans exemples", async () => {
    const out = await run2(list([tpl(), tpl({ name: "rappel", category: "UTILITY", status: "PENDING" }), tpl({ name: "ancien", status: "DISABLED" }), tpl({ name: "refuse", status: "REJECTED", category: "AUTHENTICATION" })]));
    expect(out).toMatchObject({ kind: "ok", skipped: 0 });
    if (out.kind !== "ok") return;
    expect(out.items.map((i) => [i.name, i.category, i.status])).toEqual([["offre_ete", "marketing", "approved"], ["rappel", "utility", "pending"], ["ancien", "marketing", "paused"], ["refuse", "authentication", "rejected"]]);
    expect(JSON.stringify(out.items[0]?.components)).toBe(JSON.stringify([{ type: "BODY", text: "Bonjour {{1}}" }]));
  });

  it("un modèle mal formé est écarté et compté sans empêcher les autres", () => {
    const out = parseMessageTemplates({ data: [tpl(), tpl({ name: "Nom Invalide" }), tpl({ language: "xx-yy-zz" }), tpl({ category: "AUTRE" }), 7] });
    expect(out?.items).toHaveLength(1);
    expect(out?.skipped).toBe(4);
    expect(parseMessageTemplates({ data: "x" })).toBeNull();
    expect(parseMessageTemplates(null)).toBeNull();
  });

  it("erreurs : jeton, compte, panne, réponse inexploitable ; entrées invalides sans appel", async () => {
    expect(await run2(json(401, { error: { code: 190 } }))).toEqual({ kind: "error", code: "provider_auth" });
    expect(await run2(json(400, { error: { code: 100 } }))).toEqual({ kind: "error", code: "provider_account" });
    expect(await run2(json(400, { error: { code: 4 } }))).toEqual({ kind: "error", code: "provider_unavailable" });
    expect(await run2(json(500, {}))).toEqual({ kind: "error", code: "provider_unavailable" });
    expect(await run2(new Error("réseau"))).toEqual({ kind: "error", code: "provider_unavailable" });
    expect(await run2(new Response("pas du json", { status: 200 }))).toEqual({ kind: "error", code: "provider_unreadable" });
    const f = fake(list([]));
    expect(await createWhatsAppTemplateClient({ fetch: f.fetch }).list({ wabaId: "../x", accessToken: TOKEN })).toEqual({ kind: "error", code: "provider_account" });
    expect(f.calls).toHaveLength(0);
  });

  it("appelle l'adresse fixe de Meta avec le jeton en en-tête", async () => {
    const f = fake(list([tpl()]));
    await createWhatsAppTemplateClient({ fetch: f.fetch }).list({ wabaId: WABA, accessToken: TOKEN });
    expect(f.calls[0]?.url.startsWith(`https://graph.facebook.com/v25.0/${WABA}/message_templates?`)).toBe(true);
    expect(f.calls[0]?.url).not.toContain(TOKEN);
    expect(((f.calls[0]?.init as RequestInit).headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });
});
