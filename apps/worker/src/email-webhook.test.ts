import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizePostmarkPayload, type EmailEvent } from "@fusion-leap/adapters";
import { NonRetryableError } from "./errors";
import { createProcessWebhookHandler } from "./handlers";
import { MemoryWebhooks } from "./webhooks.testkit";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc }) }));

import { createEmailWebhookProcessor, createSupabaseEmailEventGateway, EmailGatewayError, type EmailEventGateway, type InboundResult, type StatusResult } from "./email-webhook";

const ORG = "11111111-1111-4111-8111-111111111111";
const INT = "33333333-3333-4333-8333-333333333333";
const REF = "9d2a6f4e-1b3c-4d5e-8f70-a1b2c3d4e5f6";

const delivery = normalizePostmarkPayload({ RecordType: "Delivery", MessageID: "pm-1", Recipient: "k@example.test", DeliveredAt: "2026-11-05T16:33:54Z", Metadata: { fusion_message_id: REF } }) as EmailEvent;
const hardBounce = normalizePostmarkPayload({ RecordType: "Bounce", ID: 7, TypeCode: 1, MessageID: "pm-1", Email: "k@example.test", BouncedAt: "2026-11-05T16:33:54Z" }) as EmailEvent;
const complaint = normalizePostmarkPayload({ RecordType: "SpamComplaint", ID: 8, MessageID: "pm-1", Email: "k@example.test", BouncedAt: "2026-11-05T16:33:54Z" }) as EmailEvent;
const inbound = normalizePostmarkPayload({
  FromFull: { Email: "K@Example.test" }, MessageID: "in-1", ToFull: [{ Email: "ventes@acme.test" }], TextBody: "Bonjour", Subject: "Re: devis",
  Headers: [{ Name: "Received-SPF", Value: "Pass identity=mailfrom; envelope-from=K@Example.test" }],
}) as EmailEvent;

class MemoryEmail implements EmailEventGateway {
  readonly status: Array<{ org: string; integration: string; kind: string }> = [];
  readonly inboundCalls: Array<{ org: string; integration: string; from: string }> = [];
  statusResult: StatusResult = { outcome: "applied" };
  inboundResult: InboundResult = { outcome: "recorded" };
  failWith: Error | null = null;
  async applyStatus(org: string, integration: string, event: { kind: string }): Promise<StatusResult> {
    if (this.failWith) throw this.failWith;
    this.status.push({ org, integration, kind: event.kind });
    return this.statusResult;
  }
  async applyInbound(org: string, integration: string, event: { from: string }): Promise<InboundResult> {
    if (this.failWith) throw this.failWith;
    this.inboundCalls.push({ org, integration, from: event.from });
    return this.inboundResult;
  }
}

const input = (payload: unknown) => ({ organizationId: ORG, eventId: "e1", integrationId: INT, payload });

describe("processeur e-mail (process_webhook)", () => {
  it("delivered, rebond dur et plainte : appliqués avec l'entreprise et l'intégration de la LIGNE du job", async () => {
    for (const event of [delivery, hardBounce, complaint]) {
      const gateway = new MemoryEmail();
      const outcome = await createEmailWebhookProcessor(gateway).process(input(event));
      expect(outcome).toBe("processed");
      expect(gateway.status).toEqual([{ org: ORG, integration: INT, kind: event.kind }]);
    }
  });

  it("événement sans effet (message introuvable, rebond doux...) : « ignored »", async () => {
    const gateway = new MemoryEmail();
    gateway.statusResult = { outcome: "ignored", reason: "message_not_found" };
    expect(await createEmailWebhookProcessor(gateway).process(input(delivery))).toBe("ignored");
  });

  it("e-mail entrant : traité, qu'il soit rattaché, déjà vu ou placé dans la file des cas ambigus", async () => {
    for (const result of [{ outcome: "recorded" }, { outcome: "duplicate" }, { outcome: "unmatched", reason: "unknown_sender" }, { outcome: "unmatched", reason: "id_conflict" }] as InboundResult[]) {
      const gateway = new MemoryEmail();
      gateway.inboundResult = result;
      expect(await createEmailWebhookProcessor(gateway).process(input(inbound))).toBe("processed");
      expect(gateway.inboundCalls).toEqual([{ org: ORG, integration: INT, from: "k@example.test" }]);
    }
  });

  it("file des cas ambigus pleine : échec définitif et visible (unmatched_queue_full) ; limite par expéditeur : ignoré", async () => {
    const full = new MemoryEmail();
    full.inboundResult = { outcome: "dropped", reason: "queue_full" };
    await expect(createEmailWebhookProcessor(full).process(input(inbound))).rejects.toMatchObject({ code: "unmatched_queue_full" });
    const limited = new MemoryEmail();
    limited.inboundResult = { outcome: "dropped", reason: "sender_limit" };
    expect(await createEmailWebhookProcessor(limited).process(input(inbound))).toBe("ignored");
  });

  it("événement d'un autre type (ouverture, clic) : « ignored », aucun appel", async () => {
    const gateway = new MemoryEmail();
    const open = normalizePostmarkPayload({ RecordType: "Open" });
    expect(await createEmailWebhookProcessor(gateway).process(input(open))).toBe("ignored");
    expect(gateway.status).toHaveLength(0);
    expect(gateway.inboundCalls).toHaveLength(0);
  });

  it("forme conservée altérée : échec définitif (jamais rejoué), aucun appel", async () => {
    const gateway = new MemoryEmail();
    for (const bad of [null, "x", {}, { kind: "delivered" }, { ...delivery, recipient: "pas-une-adresse" }, { ...inbound, body: "" }]) {
      await expect(createEmailWebhookProcessor(gateway).process(input(bad))).rejects.toBeInstanceOf(NonRetryableError);
    }
    expect(gateway.status).toHaveLength(0);
  });

  it("panne de la base : l'erreur remonte (job rejoué) sans contenu d'e-mail", async () => {
    const gateway = new MemoryEmail();
    gateway.failWith = new EmailGatewayError("status");
    const error = await createEmailWebhookProcessor(gateway).process(input(delivery)).catch((e: Error) => e);
    expect((error as Error).message).toBe("email_status_failed");
    expect(JSON.stringify(error)).not.toContain("k@example.test");
  });

  it("branché sur process_webhook : l'événement est terminé « processed » ; sans forme valide : « failed » / invalid_event", async () => {
    const hooks = new MemoryWebhooks();
    hooks.add(ORG, "44444444-4444-4444-8444-444444444444", "email", delivery);
    hooks.add(ORG, "55555555-5555-4555-8555-555555555555", "email", { kind: "delivered" });
    const handler = createProcessWebhookHandler(hooks, new Map([["email", createEmailWebhookProcessor(new MemoryEmail())]]));
    const ctx = { jobId: "j", organizationId: ORG, idempotencyKey: "k", attempt: 1, maxAttempts: 5, signal: new AbortController().signal };
    await handler.run(ctx, { event_id: "44444444-4444-4444-8444-444444444444" });
    await expect(handler.run(ctx, { event_id: "55555555-5555-4555-8555-555555555555" })).rejects.toBeInstanceOf(NonRetryableError);
    expect(hooks.events.get("44444444-4444-4444-8444-444444444444")?.status).toBe("processed");
    expect(hooks.events.get("55555555-5555-4555-8555-555555555555")).toMatchObject({ status: "failed", failureCode: "invalid_event" });
  });
});

describe("passerelle Supabase des événements e-mail", () => {
  beforeEach(() => {
    rpc.mockReset();
  });
  const gateway = () => createSupabaseEmailEventGateway({ SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SECRET_KEY: "cle-secrete-de-test" });

  it("statut : fonction SQL avec l'entreprise du job, l'identifiant du fournisseur et la référence de NOTRE message", async () => {
    rpc.mockResolvedValue({ data: { outcome: "applied" }, error: null });
    const result = await gateway().applyStatus(ORG, INT, hardBounce as never);
    expect(result).toEqual({ outcome: "applied" });
    expect(rpc).toHaveBeenCalledWith("email_status_apply", {
      p_org: ORG, p_integration: INT, p_event: "bounced", p_hard: true, p_provider_message_id: "pm-1", p_ref: null, p_event_at: "2026-11-05T16:33:54.000Z",
    });
    rpc.mockClear();
    rpc.mockResolvedValue({ data: { outcome: "ignored", reason: "soft_bounce" }, error: null });
    expect(await gateway().applyStatus(ORG, INT, delivery as never)).toEqual({ outcome: "ignored", reason: "soft_bounce" });
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_event: "delivered", p_hard: false, p_ref: REF });
  });

  it("entrant : adresse expéditrice, destinataires, corps et indicateurs SPF / spam transmis tels quels", async () => {
    rpc.mockResolvedValue({ data: { outcome: "unmatched", reason: "unknown_sender" }, error: null });
    expect(await gateway().applyInbound(ORG, INT, inbound as never)).toEqual({ outcome: "unmatched", reason: "unknown_sender" });
    expect(rpc).toHaveBeenCalledWith("email_inbound_apply", {
      p_org: ORG, p_integration: INT, p_provider_message_id: "in-1", p_recipients: ["ventes@acme.test"], p_from: "k@example.test", p_subject: "Re: devis",
      p_body: "Bonjour", p_received_at: null, p_verified: true, p_spam: false,
    });
  });

  it("erreurs : « retry_later » est reconnue (envoi encore en cours) ; autres pannes et réponses mal formées : erreur générique sans fuite", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "retry_later", code: "P0001" } });
    await expect(gateway().applyStatus(ORG, INT, delivery as never)).rejects.toThrow("email_retry_later_failed");
    rpc.mockResolvedValue({ data: null, error: { message: "relation public.messages k@example.test", code: "XX000" } });
    const failure = await gateway().applyStatus(ORG, INT, delivery as never).catch((e: Error) => e);
    expect((failure as Error).message).toBe("email_status_failed");
    expect(JSON.stringify(failure)).not.toContain("k@example.test");
    rpc.mockResolvedValue({ data: { outcome: "inconnu" }, error: null });
    await expect(gateway().applyStatus(ORG, INT, delivery as never)).rejects.toThrow("email_status_failed");
    rpc.mockResolvedValue({ data: null, error: { message: "boom Bonjour", code: "XX000" } });
    await expect(gateway().applyInbound(ORG, INT, inbound as never)).rejects.toThrow("email_inbound_failed");
    rpc.mockResolvedValue({ data: { outcome: "x" }, error: null });
    await expect(gateway().applyInbound(ORG, INT, inbound as never)).rejects.toThrow("email_inbound_failed");
    rpc.mockResolvedValue({ data: { outcome: "dropped", reason: "queue_full" }, error: null });
    expect(await gateway().applyInbound(ORG, INT, inbound as never)).toEqual({ outcome: "dropped", reason: "queue_full" });
  });
});
