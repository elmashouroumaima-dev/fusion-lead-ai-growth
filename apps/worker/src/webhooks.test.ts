import { beforeEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError } from "./errors";
import { createProcessWebhookHandler } from "./handlers";
import { FakeProcessor, MemoryWebhooks } from "./webhooks.testkit";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc }) }));

import { createSupabaseWebhookGateway, WebhookGatewayError } from "./webhooks";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const EVENT = "44444444-4444-4444-8444-444444444444";
const INT = "33333333-3333-4333-8333-333333333333";

const ctx = (over: Record<string, unknown> = {}) => ({
  jobId: "55555555-5555-4555-8555-555555555555",
  organizationId: ORG,
  idempotencyKey: `process_webhook:${EVENT}`,
  attempt: 1,
  maxAttempts: 5,
  signal: new AbortController().signal,
  ...over,
});

describe("process_webhook", () => {
  it("charge utile stricte : identifiant d'événement seulement", () => {
    const handler = createProcessWebhookHandler(new MemoryWebhooks(), new Map());
    expect(handler.kind).toBe("process_webhook");
  });

  it("événement traité par le processeur du fournisseur : terminé « processed », avec l'entreprise de la ligne du job", async () => {
    const gateway = new MemoryWebhooks();
    gateway.add(ORG, EVENT, "whatsapp", { hello: "monde" });
    const processor = new FakeProcessor("whatsapp");
    await createProcessWebhookHandler(gateway, new Map([["whatsapp", processor]])).run(ctx(), { event_id: EVENT });
    expect(processor.calls).toEqual([{ organizationId: ORG, eventId: EVENT, integrationId: INT, payload: { hello: "monde" } }]);
    expect(gateway.events.get(EVENT)?.status).toBe("processed");
  });

  it("processeur qui répond « ignored » : statut ignored", async () => {
    const gateway = new MemoryWebhooks();
    gateway.add(ORG, EVENT);
    const processor = new FakeProcessor();
    processor.outcome = "ignored";
    await createProcessWebhookHandler(gateway, new Map([["whatsapp", processor]])).run(ctx(), { event_id: EVENT });
    expect(gateway.events.get(EVENT)?.status).toBe("ignored");
  });

  it("sans processeur pour le fournisseur : « failed » avec le code no_processor (re-jouable) ; le payload reste en base", async () => {
    const gateway = new MemoryWebhooks();
    gateway.add(ORG, EVENT, "email", { garde: "moi" });
    await createProcessWebhookHandler(gateway, new Map()).run(ctx(), { event_id: EVENT });
    expect(gateway.events.get(EVENT)).toMatchObject({ status: "failed", failureCode: "no_processor", payload: { garde: "moi" } });
  });

  it("rejeu du job : un événement terminé n'est pas retraité", async () => {
    const gateway = new MemoryWebhooks();
    gateway.add(ORG, EVENT);
    const processor = new FakeProcessor();
    const handler = createProcessWebhookHandler(gateway, new Map([["whatsapp", processor]]));
    await handler.run(ctx(), { event_id: EVENT });
    await handler.run(ctx({ attempt: 2 }), { event_id: EVENT });
    expect(processor.calls).toHaveLength(1);
  });

  it("événement inconnu ou d'une autre entreprise : rien n'est traité (le job du tenant A ne touche pas B)", async () => {
    const gateway = new MemoryWebhooks();
    gateway.add(OTHER_ORG, EVENT);
    const processor = new FakeProcessor();
    const handler = createProcessWebhookHandler(gateway, new Map([["whatsapp", processor]]));
    await handler.run(ctx(), { event_id: EVENT });
    await handler.run(ctx(), { event_id: "66666666-6666-4666-8666-666666666666" });
    expect(processor.calls).toHaveLength(0);
    expect(gateway.events.get(EVENT)?.status).toBe("received");
  });

  it("panne réessayable : l'erreur remonte (nouvelle tentative), l'événement reste « received » ; à la dernière tentative : « failed »", async () => {
    const gateway = new MemoryWebhooks();
    gateway.add(ORG, EVENT);
    const processor = new FakeProcessor();
    processor.error = new Error("panne");
    const handler = createProcessWebhookHandler(gateway, new Map([["whatsapp", processor]]));
    await expect(handler.run(ctx({ attempt: 1 }), { event_id: EVENT })).rejects.toThrow("panne");
    expect(gateway.events.get(EVENT)?.status).toBe("received");
    await expect(handler.run(ctx({ attempt: 5 }), { event_id: EVENT })).rejects.toThrow("panne");
    expect(gateway.events.get(EVENT)).toMatchObject({ status: "failed", failureCode: "failed" });
  });

  it("erreur définitive : « failed » avec son code, sans réessai", async () => {
    const gateway = new MemoryWebhooks();
    gateway.add(ORG, EVENT);
    const processor = new FakeProcessor();
    processor.error = new NonRetryableError("payload_invalide");
    await expect(createProcessWebhookHandler(gateway, new Map([["whatsapp", processor]])).run(ctx(), { event_id: EVENT })).rejects.toBeInstanceOf(NonRetryableError);
    expect(gateway.events.get(EVENT)).toMatchObject({ status: "failed", failureCode: "payload_invalide" });
  });

  it("panne de la base au démarrage : l'erreur remonte, rien n'est marqué", async () => {
    const gateway = new MemoryWebhooks();
    gateway.add(ORG, EVENT);
    gateway.failStart = true;
    await expect(createProcessWebhookHandler(gateway, new Map([["whatsapp", new FakeProcessor()]])).run(ctx(), { event_id: EVENT })).rejects.toThrow("webhook_start_failed");
    expect(gateway.events.get(EVENT)?.status).toBe("received");
  });
});

describe("passerelle webhook (service_role)", () => {
  const gateway = createSupabaseWebhookGateway({ SUPABASE_URL: "http://localhost:54321", SUPABASE_SECRET_KEY: "clé-de-test" });
  beforeEach(() => {
    rpc.mockReset();
  });

  it("start : l'entreprise de la ligne du job ; événement en cours, terminé ou introuvable", async () => {
    rpc.mockResolvedValue({ data: { status: "running", provider: "whatsapp", integration_id: INT, payload: { a: 1 } }, error: null });
    expect(await gateway.start(ORG, EVENT)).toEqual({ status: "running", provider: "whatsapp", integrationId: INT, payload: { a: 1 } });
    expect(rpc).toHaveBeenCalledWith("webhook_start", { p_org: ORG, p_event: EVENT });
    rpc.mockResolvedValue({ data: { status: "done" }, error: null });
    expect(await gateway.start(ORG, EVENT)).toEqual({ status: "done" });
    rpc.mockResolvedValue({ data: { status: "missing" }, error: null });
    expect(await gateway.start(ORG, EVENT)).toEqual({ status: "missing" });
  });

  it("start : réponse inattendue ou erreur = erreur opaque (ni SQL, ni payload, ni clé)", async () => {
    rpc.mockResolvedValue({ data: { status: "autre" }, error: null });
    await expect(gateway.start(ORG, EVENT)).rejects.toThrow("webhook_start_failed");
    rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "détail SQL secret" } });
    const error = await gateway.start(ORG, EVENT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebhookGatewayError);
    expect(String((error as Error).message)).not.toContain("secret");
  });

  it("finish : statut et code transmis ; erreur = erreur opaque", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await gateway.finish(ORG, EVENT, "failed", "failed");
    expect(rpc).toHaveBeenCalledWith("webhook_finish", { p_org: ORG, p_event: EVENT, p_status: "failed", p_failure: "failed" });
    rpc.mockResolvedValue({ data: null, error: { message: "x" } });
    await expect(gateway.finish(ORG, EVENT, "processed", null)).rejects.toThrow("webhook_finish_failed");
  });
});
