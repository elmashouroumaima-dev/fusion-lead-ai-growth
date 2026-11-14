import { createKeyRing, type EmailProvider, type EmailSendInput, type EmailSendOutcome, type WhatsAppSender, type WhatsAppSendInput, type WhatsAppSendOutcome } from "@fusion-leap/adapters";
import type { SendClaim, SendGateway } from "./send";
import type { SendDeps } from "./handlers";

export const SEND_ORG = "11111111-1111-4111-8111-111111111111";
export const SEND_MESSAGE = "22222222-2222-4222-8222-222222222222";
export const SEND_INTEGRATION = "33333333-3333-4333-8333-333333333333";

/** État « tout en règle » d'un message prêt à partir ; les tests en dérivent les cas de refus. */
export function claimedOk(patch: Partial<Extract<SendClaim, { status: "claimed" }>> = {}): Extract<SendClaim, { status: "claimed" }> {
  return {
    status: "claimed",
    message: { body: "Bonjour Karim\nVoici notre offre.", approved: true, purpose: "marketing", approverValid: true, approvalAgeSeconds: 120, recipientUnchanged: true },
    contact: { email: "karim@example.test", phone: "+212600000001", doNotContact: false },
    channel: { type: "email", status: "active", sendPaused: false, sender: "ventes@acme.test", integrationId: SEND_INTEGRATION, integrationStatus: "active", account: "106540352242922" },
    windowOpen: true,
    template: null,
    organizationActive: true,
    organizationSendPaused: false,
    consent: true,
    suppressed: false,
    sentLastHour: 0,
    ...patch,
  };
}

/** Passerelle en mémoire : applique la règle de la base (une seule tentative réclamée, résultats terminaux). */
export class MemorySend implements SendGateway {
  claimResult: SendClaim = claimedOk();
  readonly calls: string[] = [];
  readonly failed: Array<{ code: string }> = [];
  readonly accepted: Array<{ providerMessageId: string }> = [];
  claimed = 0;
  released = 0;
  failClaim = false;
  failAccept = 0;
  failRelease = false;

  async claim(organizationId: string, messageId: string): Promise<SendClaim> {
    this.calls.push(`claim:${organizationId}:${messageId}`);
    if (this.failClaim) throw new Error("send_claim_failed");
    if (this.claimResult.status === "claimed") this.claimed += 1;
    return this.claimResult;
  }
  async markAccepted(_org: string, _message: string, providerMessageId: string): Promise<void> {
    this.calls.push("accepted");
    if (this.failAccept > 0) {
      this.failAccept -= 1;
      throw new Error("send_accept_failed");
    }
    this.accepted.push({ providerMessageId });
  }
  async markFailed(_org: string, _message: string, code: string): Promise<void> {
    this.calls.push(`failed:${code}`);
    this.failed.push({ code });
  }
  async releaseClaim(): Promise<void> {
    this.calls.push("release");
    if (this.failRelease) throw new Error("send_release_failed");
    this.released += 1;
  }
}

export class FakeEmailProvider implements EmailProvider {
  readonly name = "fake";
  readonly sent: Array<{ input: EmailSendInput; secret: string }> = [];
  outcome: EmailSendOutcome = { kind: "accepted", providerMessageId: "pm-123" };
  async send(input: EmailSendInput, secret: string): Promise<EmailSendOutcome> {
    this.sent.push({ input, secret });
    return this.outcome;
  }
}

export class FakeWhatsAppSender implements WhatsAppSender {
  readonly name = "fake_whatsapp";
  readonly sent: Array<{ input: WhatsAppSendInput; secret: string }> = [];
  outcome: WhatsAppSendOutcome = { kind: "accepted", providerMessageId: "wamid.TEST" };
  async send(input: WhatsAppSendInput, secret: string): Promise<WhatsAppSendOutcome> {
    this.sent.push({ input, secret });
    return this.outcome;
  }
}

/** Dépendances d'envoi par défaut des tests qui n'envoient rien. */
export function noSend(): SendDeps {
  return { gateway: new MemorySend(), readSecret: async () => "tok-test-0123456789", provider: new FakeEmailProvider(), whatsapp: new FakeWhatsAppSender(), unsubscribe: testUnsubscribe() };
}

/** Trousseau de test (clé fixe, jamais utilisée hors tests) et site de test pour le lien de désabonnement. */
export const TEST_SITE_URL = "https://app.acme.test";
export function testUnsubscribe(): SendDeps["unsubscribe"] {
  return { keyRing: createKeyRing(1, { 1: Buffer.alloc(32, 7).toString("base64") }), siteUrl: TEST_SITE_URL };
}
