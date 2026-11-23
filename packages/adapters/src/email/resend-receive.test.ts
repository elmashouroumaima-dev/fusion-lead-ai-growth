import { describe, expect, it, vi } from "vitest";
import { readEmailEvent } from "./events";
import { createResendReceiver, htmlToText, RESEND_RECEIVING_BASE } from "./resend-receive";

const ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const full = (over: Record<string, unknown> = {}) => ({
  object: "email", id: ID, from: "Client <Client@Exemple.test>", to: ["ventes@acme.test"], received_for: ["ventes@acme.test"], subject: "Re: devis",
  text: "Bonjour, ok pour le devis.", html: "<p>autre</p>", created_at: "2026-11-24T10:00:00.000Z", message_id: "<abc@mail.exemple.test>",
  authentication: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: { from: "x" }, attachments: [], ...over,
});
const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
const run = (status: number, body: unknown, id = ID, key = "re_k") => createResendReceiver({ fetch: reply(status, body) as unknown as typeof fetch }).fetchInbound(id, key);

describe("createResendReceiver", () => {
  it("lit le message sur l'adresse fixe, avec la clé en Bearer, et le normalise comme un entrant", async () => {
    const f = reply(200, full());
    const out = await createResendReceiver({ fetch: f as unknown as typeof fetch }).fetchInbound(ID, "re_k");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${RESEND_RECEIVING_BASE}${ID}?html_format=cid`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_k");
    expect(init.redirect).toBe("error");
    expect(out.kind).toBe("received");
    if (out.kind !== "received") return;
    expect(out.event).toMatchObject({ kind: "inbound", eventId: `inbound:${ID}`, providerMessageId: ID, from: "client@exemple.test", recipients: ["ventes@acme.test"], subject: "Re: devis", body: "Bonjour, ok pour le devis.", at: "2026-11-24T10:00:00.000Z", spfPass: true, spam: false });
    // la forme produite est relisible telle quelle par le worker
    expect(readEmailEvent(out.event)).not.toBeNull();
  });
  it("destinataires : l'adresse réellement atteinte (received_for), jamais l'en-tête « to » quand elle existe", async () => {
    const out = await run(200, full({ to: ["forge@autre.test"], received_for: ["ventes@acme.test"] }));
    expect(out.kind === "received" && out.event.recipients).toEqual(["ventes@acme.test"]);
    const fallback = await run(200, full({ received_for: [], to: ["ventes@acme.test"] }));
    expect(fallback.kind === "received" && fallback.event.recipients).toEqual(["ventes@acme.test"]);
  });
  it("expéditeur non authentifié sans DMARC « pass » (SPF seul, échec, absent)", async () => {
    for (const authentication of [{ spf: "pass", dkim: "fail", dmarc: "fail" }, { dmarc: "gray" }, null, undefined]) {
      const out = await run(200, full({ authentication }));
      expect(out.kind === "received" && out.event.spfPass).toBe(false);
    }
  });
  it("sans texte brut : le HTML est converti en texte (balises et scripts retirés) ; sans rien : message vide explicite", async () => {
    const out = await run(200, full({ text: null, html: "<div>Bonjour<script>alert(1)</script><br>à&nbsp;bientôt &amp; merci</div>" }));
    expect(out.kind === "received" && out.event.body).toBe("Bonjour\nà bientôt & merci");
    const empty = await run(200, full({ text: null, html: null }));
    expect(empty.kind === "received" && empty.event.body).toBe("(message sans texte)");
  });
  it("sujet absent = null ; date illisible = null", async () => {
    const out = await run(200, full({ subject: "", created_at: "pas une date" }));
    expect(out.kind === "received" && [out.event.subject, out.event.at]).toEqual([null, null]);
  });
  it.each([
    [401, "rejected", "provider_auth"],
    [403, "rejected", "provider_auth"],
    [404, "retryable", "not_found_yet"],
    [429, "retryable", "provider_rate_limited"],
    [503, "retryable", "provider_unavailable"],
    [418, "rejected", "provider_rejected"],
  ])("statut %i -> %s %s", async (status, kind, code) => {
    expect(await run(status, {})).toEqual({ kind, code });
  });
  it("réponse inexploitable, expéditeur ou destinataire illisible : refus définitif", async () => {
    expect(await run(200, [])).toEqual({ kind: "rejected", code: "unreadable_response" });
    expect(await run(200, full({ from: "pas une adresse" }))).toEqual({ kind: "rejected", code: "invalid_sender" });
    expect(await run(200, full({ received_for: ["x"], to: ["y"] }))).toEqual({ kind: "rejected", code: "no_recipient" });
  });
  it("identifiant ou clé invalides : aucun appel réseau", async () => {
    const f = reply(200, full());
    const r = createResendReceiver({ fetch: f as unknown as typeof fetch });
    expect(await r.fetchInbound("../../domains", "re_k")).toEqual({ kind: "rejected", code: "invalid_id" });
    expect(await r.fetchInbound(ID, "")).toEqual({ kind: "rejected", code: "provider_auth" });
    expect(f).not.toHaveBeenCalled();
  });
  it("coupure réseau : réessayable ; réponse trop grosse : refus définitif", async () => {
    const boom = vi.fn(async () => { throw new Error("x"); });
    expect(await createResendReceiver({ fetch: boom as unknown as typeof fetch }).fetchInbound(ID, "re_k")).toEqual({ kind: "retryable", code: "no_response" });
    const big = vi.fn(async () => new Response("x".repeat(2 * 1024 * 1024 + 10), { status: 200 }));
    expect(await createResendReceiver({ fetch: big as unknown as typeof fetch }).fetchInbound(ID, "re_k")).toEqual({ kind: "rejected", code: "response_too_large" });
  });
});

describe("htmlToText", () => {
  it("retire les balises sans les interpréter", () => {
    expect(htmlToText("<p>a</p><p>b &lt;c&gt;</p>")).toBe("a\nb <c>");
  });
});
