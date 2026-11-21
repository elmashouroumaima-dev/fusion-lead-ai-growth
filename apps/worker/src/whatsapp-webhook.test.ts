import { describe, expect, it } from "vitest";
import { normalizeWhatsAppPayload } from "@fusion-leap/adapters";
import { createWhatsAppWebhookProcessor, type InboundResult, type MarketingPreferenceEvent, type MessageEvent, type StatusEvent, type StatusResult, type WhatsAppEventGateway } from "./whatsapp-webhook";

const ORG = "11111111-1111-4111-8111-111111111111";
const INT = "33333333-3333-4333-8333-333333333333";
const PHONE = "106540352242922";

const wrap = (value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "1", changes: [{ field: "messages", value: { metadata: { phone_number_id: PHONE }, ...value } }] }],
});
const message = (id: string, patch: Record<string, unknown> = {}) => ({ from: "212600000000", id, timestamp: "1700000000", text: { body: "Bonjour" }, type: "text", ...patch });
const status = (id: string, s: string, errors?: unknown) => ({ id, status: s, timestamp: "1700000100", ...(errors ? { errors } : {}) });
const stored = (value: Record<string, unknown>) => JSON.parse(JSON.stringify(normalizeWhatsAppPayload(wrap(value)))) as unknown;

class Memory implements WhatsAppEventGateway {
  readonly messages: Array<{ org: string; integration: string; event: MessageEvent }> = [];
  readonly statuses: Array<{ org: string; integration: string; event: StatusEvent }> = [];
  readonly preferences: Array<{ org: string; integration: string; event: MarketingPreferenceEvent }> = [];
  inbound: InboundResult = { outcome: "recorded" };
  statusResult: StatusResult = { outcome: "applied" };
  fail = false;
  async applyMessage(org: string, integration: string, event: MessageEvent) {
    if (this.fail) throw new Error("whatsapp_inbound_failed");
    this.messages.push({ org, integration, event });
    return this.inbound;
  }
  async applyStatus(org: string, integration: string, event: StatusEvent) {
    this.statuses.push({ org, integration, event });
    return this.statusResult;
  }
  async applyMarketingPreference(org: string, integration: string, event: MarketingPreferenceEvent) {
    this.preferences.push({ org, integration, event });
    return this.statusResult;
  }
}
const run = (gateway: Memory, payload: unknown) => createWhatsAppWebhookProcessor(gateway).process({ organizationId: ORG, integrationId: INT, payload } as never);

describe("processeur des événements WhatsApp (J35)", () => {
  it("fournisseur : whatsapp", () => {
    expect(createWhatsAppWebhookProcessor(new Memory()).provider).toBe("whatsapp");
  });

  it("applique chaque message et chaque statut avec l'entreprise et l'intégration de la LIGNE, dans l'ordre", async () => {
    const g = new Memory();
    expect(await run(g, stored({ messages: [message("wamid.A"), message("wamid.B", { text: undefined, type: "image" })], statuses: [status("wamid.O", "delivered")] }))).toBe("processed");
    expect(g.messages.map((m) => [m.org, m.integration, m.event.id, m.event.text])).toEqual([[ORG, INT, "wamid.A", "Bonjour"], [ORG, INT, "wamid.B", null]]);
    expect(g.statuses.map((s) => [s.org, s.integration, s.event.id, s.event.status])).toEqual([[ORG, INT, "wamid.O", "delivered"]]);
  });

  it("rien d'appliqué (statuts ignorés, notifications sans événement) : « ignored »", async () => {
    const g = new Memory();
    g.statusResult = { outcome: "ignored", reason: "message_not_found" };
    expect(await run(g, stored({ statuses: [status("wamid.O", "read")] }))).toBe("ignored");
    expect(await run(new Memory(), stored({ event: "VERIFIED_ACCOUNT" }))).toBe("ignored");
  });

  it("message en double ou placé dans la file de tri : traité (pas d'échec) ; file trop pleine pour un expéditeur : ignoré", async () => {
    const g = new Memory();
    for (const outcome of [{ outcome: "duplicate" }, { outcome: "unmatched", reason: "unknown_sender" }] as InboundResult[]) {
      g.inbound = outcome;
      expect(await run(g, stored({ messages: [message("wamid.A")] }))).toBe("processed");
    }
    g.inbound = { outcome: "dropped", reason: "sender_limit" };
    expect(await run(g, stored({ messages: [message("wamid.A")] }))).toBe("ignored");
  });

  it("file des cas ambigus pleine : les AUTRES événements sont d'abord traités, puis échec définitif visible", async () => {
    const g = new Memory();
    g.inbound = { outcome: "dropped", reason: "queue_full" };
    await expect(run(g, stored({ messages: [message("wamid.A")], statuses: [status("wamid.O", "sent")] }))).rejects.toMatchObject({ name: "NonRetryableError", message: "unmatched_queue_full" });
    expect(g.statuses).toHaveLength(1);
  });

  it("forme conservée altérée : échec définitif, rien n'est appliqué", async () => {
    const g = new Memory();
    for (const bad of [null, {}, "x", { ...(stored({ messages: [message("wamid.A")] }) as object), phoneNumberIds: [] }]) {
      await expect(run(g, bad)).rejects.toMatchObject({ name: "NonRetryableError", message: "invalid_event" });
    }
    expect(g.messages).toHaveLength(0);
  });

  it("panne de la base : l'erreur remonte (le job sera rejoué : sans danger, tout est dédupliqué)", async () => {
    const g = new Memory();
    g.fail = true;
    await expect(run(g, stored({ messages: [message("wamid.A")] }))).rejects.toThrow("whatsapp_inbound_failed");
  });

  it("aucun texte de message dans une erreur ou un résultat", async () => {
    const g = new Memory();
    g.fail = true;
    const error = await run(g, stored({ messages: [message("wamid.A", { text: { body: "SECRET-CONTENU" } })] })).catch((e: Error) => e);
    expect(String(error)).not.toContain("SECRET-CONTENU");
  });
});

describe("préférence marketing annoncée par la passerelle (STOP Kapso, ADR 017)", () => {
  const preference = (status: string) => ({ object: "whatsapp_business_account", phoneNumberIds: [PHONE], skipped: 0, events: [{ kind: "marketing_preference", id: "mp.212600000000.1", from: "+212600000000", at: null, status }] });

  it("« stopped » : appliquée avec l'entreprise et l'intégration de la LIGNE ; l'événement est traité (jamais pris pour un statut)", async () => {
    const g = new Memory();
    expect(await run(g, preference("stopped"))).toBe("processed");
    expect(g.preferences.map((p) => [p.org, p.integration, p.event.from, p.event.status])).toEqual([[ORG, INT, "+212600000000", "stopped"]]);
    expect(g.statuses).toHaveLength(0);
    expect(g.messages).toHaveLength(0);
  });

  it("« resumed » ignoré par la base : « ignored », rien n'est réactivé par le worker", async () => {
    const g = new Memory();
    g.statusResult = { outcome: "ignored", reason: "resumed_not_applied" };
    expect(await run(g, preference("resumed"))).toBe("ignored");
  });

  it("forme altérée (statut inconnu, numéro sans « + ») : jamais rejouable", async () => {
    const g = new Memory();
    await expect(run(g, preference("autre"))).rejects.toMatchObject({ message: "invalid_event" });
    const bad = preference("stopped");
    (bad.events[0] as { from: string }).from = "212600000000";
    await expect(run(g, bad)).rejects.toMatchObject({ message: "invalid_event" });
    expect(g.preferences).toHaveLength(0);
  });
});
