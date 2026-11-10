import type { WebhookFinishStatus, WebhookGateway, WebhookProcessor, WebhookProcessorInput, WebhookStart } from "./webhooks";

/** Passerelle en mémoire pour les tests : suit l'état d'événements, comme la base (un événement ne se termine qu'une fois). */
export class MemoryWebhooks implements WebhookGateway {
  readonly events = new Map<string, { organizationId: string; provider: string; integrationId: string; payload: unknown; status: string; failureCode: string | null }>();
  readonly started: Array<{ organizationId: string; eventId: string }> = [];
  failStart = false;
  failFinish = false;

  add(organizationId: string, eventId: string, provider = "whatsapp", payload: unknown = { k: "v" }): void {
    this.events.set(eventId, { organizationId, provider, integrationId: "33333333-3333-4333-8333-333333333333", payload, status: "received", failureCode: null });
  }

  async start(organizationId: string, eventId: string): Promise<WebhookStart> {
    this.started.push({ organizationId, eventId });
    if (this.failStart) throw new Error("webhook_start_failed");
    const event = this.events.get(eventId);
    if (!event || event.organizationId !== organizationId) return { status: "missing" };
    if (event.status !== "received") return { status: "done" };
    return { status: "running", provider: event.provider, integrationId: event.integrationId, payload: event.payload };
  }

  async finish(organizationId: string, eventId: string, status: WebhookFinishStatus, failureCode: string | null): Promise<void> {
    if (this.failFinish) throw new Error("webhook_finish_failed");
    const event = this.events.get(eventId);
    if (!event || event.organizationId !== organizationId || event.status !== "received") return;
    event.status = status;
    event.failureCode = failureCode;
  }
}

/** Processeur factice : enregistre les appels, peut échouer. */
export class FakeProcessor implements WebhookProcessor {
  readonly calls: WebhookProcessorInput[] = [];
  outcome: "processed" | "ignored" = "processed";
  error: Error | null = null;
  constructor(readonly provider = "whatsapp") {}
  async process(input: WebhookProcessorInput): Promise<"processed" | "ignored"> {
    this.calls.push(input);
    if (this.error) throw this.error;
    return this.outcome;
  }
}
