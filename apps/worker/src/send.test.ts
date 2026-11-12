import { describe, expect, it } from "vitest";
import { createSendMessageHandler, type JobContext } from "./handlers";
import { claimedOk, FakeEmailProvider, MemorySend, SEND_INTEGRATION, SEND_MESSAGE, SEND_ORG } from "./send.testkit";

const ctx = (patch: Partial<JobContext> = {}): JobContext => ({
  jobId: "44444444-4444-4444-8444-444444444444", organizationId: SEND_ORG, idempotencyKey: "send-message:x", attempt: 1, maxAttempts: 5, signal: new AbortController().signal, ...patch,
});

function setup(readSecret: (org: string, integration: string) => Promise<string | null> = async () => "tok-SECRET-0123456789") {
  const gateway = new MemorySend();
  const provider = new FakeEmailProvider();
  const secrets: Array<[string, string]> = [];
  const handler = createSendMessageHandler({
    gateway, provider, readSecret: async (org, integration) => { secrets.push([org, integration]); return readSecret(org, integration); },
  });
  const run = (patch: Partial<JobContext> = {}) => handler.run(ctx(patch), { message_id: SEND_MESSAGE });
  return { gateway, provider, handler, run, secrets };
}

describe("send_message : charge utile", () => {
  it("n'accepte que l'identifiant du message (strict)", () => {
    const { handler } = setup();
    expect(handler.parse({ message_id: SEND_MESSAGE }).success).toBe(true);
    expect(handler.parse({ message_id: SEND_MESSAGE, to: "x@y.test" }).success).toBe(false);
    expect(handler.parse({ message_id: SEND_MESSAGE, organization_id: SEND_ORG }).success).toBe(false);
    expect(handler.parse({ message_id: "pas-un-uuid" }).success).toBe(false);
    expect(handler.parse({}).success).toBe(false);
  });
});

describe("send_message : chemin nominal", () => {
  it("envoie, enregistre l'identifiant du fournisseur et laisse le message « accepted » (jamais delivered)", async () => {
    const { gateway, provider, run, secrets } = setup();
    await run();
    expect(provider.sent).toHaveLength(1);
    const call = provider.sent[0];
    expect(call?.input).toEqual({ from: "ventes@acme.test", to: "karim@example.test", subject: "Bonjour Karim", textBody: "Bonjour Karim\nVoici notre offre.", metadata: { fusion_message_id: SEND_MESSAGE } });
    expect(call?.secret).toBe("tok-SECRET-0123456789");
    expect(gateway.accepted).toEqual([{ providerMessageId: "pm-123" }]);
    expect(gateway.calls.filter((c) => c.startsWith("failed"))).toEqual([]);
    expect(secrets).toEqual([[SEND_ORG, SEND_INTEGRATION]]);
  });

  it("l'entreprise lue est celle de la ligne du job, et le destinataire vient du contact (pas de la charge utile)", async () => {
    const { gateway, run } = setup();
    await run();
    expect(gateway.calls[0]).toBe(`claim:${SEND_ORG}:${SEND_MESSAGE}`);
  });

  it("le contrôle final a lieu APRÈS la relecture et AVANT l'appel", async () => {
    const order: string[] = [];
    const gateway = new MemorySend();
    const original = gateway.claim.bind(gateway);
    gateway.claim = async (o, m) => { order.push("claim"); return original(o, m); };
    const provider = new FakeEmailProvider();
    const send = provider.send.bind(provider);
    provider.send = async (i, s) => { order.push("provider"); return send(i, s); };
    const handler = createSendMessageHandler({ gateway, provider, readSecret: async () => { order.push("secret"); return "tok-0123456789"; } });
    await handler.run(ctx(), { message_id: SEND_MESSAGE });
    expect(order).toEqual(["claim", "secret", "provider"]);
  });
});

describe("send_message : refus de la chaîne de contrôles (aucun appel au fournisseur)", () => {
  const refusals: Array<[string, Parameters<typeof claimedOk>[0], string]> = [
    ["sans approbation humaine", { message: { ...claimedOk().message, approved: false, purpose: null } }, "refused_not_approved"],
    ["approbateur plus owner / admin actif", { message: { ...claimedOk().message, approverValid: false } }, "refused_approval_invalid"],
    ["approbation périmée", { message: { ...claimedOk().message, approvalAgeSeconds: 80 * 3600 } }, "refused_approval_stale"],
    ["adresse modifiée depuis l'approbation", { message: { ...claimedOk().message, recipientUnchanged: false } }, "refused_recipient_changed"],
    ["entreprise suspendue ou abonnement inactif", { organizationActive: false }, "refused_organization_inactive"],
    ["sans consentement", { consent: false }, "refused_no_consent"],
    ["ne plus contacter", { contact: { email: "k@example.test", doNotContact: true } }, "refused_do_not_contact"],
    ["adresse supprimée", { suppressed: true }, "refused_suppressed"],
    ["entreprise en pause", { organizationSendPaused: true }, "refused_organization_paused"],
    ["canal en pause", { channel: { ...claimedOk().channel, sendPaused: true } }, "refused_channel_paused"],
    ["canal non actif", { channel: { ...claimedOk().channel, status: "pending" } }, "refused_channel_inactive"],
    ["intégration déconnectée", { channel: { ...claimedOk().channel, integrationStatus: "disconnected" } }, "refused_channel_inactive"],
    ["sans adresse", { contact: { email: null, doNotContact: false } }, "refused_no_recipient"],
  ];
  for (const [label, patch, code] of refusals) {
    it(`${label} : message « failed » (${code}), job réussi, rien d'envoyé`, async () => {
      const { gateway, provider, run, secrets } = setup();
      gateway.claimResult = claimedOk(patch);
      await run();
      expect(provider.sent).toHaveLength(0);
      expect(secrets).toHaveLength(0);
      expect(gateway.failed).toEqual([{ code }]);
      expect(gateway.accepted).toHaveLength(0);
    });
  }

  it("canal non e-mail : refusé (channel_unsupported)", async () => {
    const { gateway, provider, run } = setup();
    gateway.claimResult = claimedOk({ channel: { ...claimedOk().channel, type: "whatsapp" } });
    await run();
    expect(provider.sent).toHaveLength(0);
    expect(gateway.failed).toEqual([{ code: "channel_unsupported" }]);
  });

  it("limite de débit : tentative libérée et job rejoué plus tard ; à la dernière tentative, message « failed »", async () => {
    const a = setup();
    a.gateway.claimResult = claimedOk({ sentLastHour: 100 });
    await expect(a.run({ attempt: 1 })).rejects.toThrow("rate_limited");
    expect(a.gateway.released).toBe(1);
    expect(a.gateway.failed).toHaveLength(0);
    expect(a.provider.sent).toHaveLength(0);

    const b = setup();
    b.gateway.claimResult = claimedOk({ sentLastHour: 100 });
    await b.run({ attempt: 5, maxAttempts: 5 });
    expect(b.gateway.failed).toEqual([{ code: "refused_rate_limited" }]);
  });
});

describe("send_message : un message n'est jamais envoyé deux fois", () => {
  it("message inconnu, d'une autre entreprise ou déjà traité : ignoré sans effet", async () => {
    for (const status of ["missing", "not_queued"] as const) {
      const { gateway, provider, run } = setup();
      gateway.claimResult = { status };
      await run();
      expect(provider.sent).toHaveLength(0);
      expect(gateway.failed).toHaveLength(0);
      expect(gateway.accepted).toHaveLength(0);
    }
  });

  it("tentative posée il y a moins de 5 minutes (autre worker en cours) : rien d'envoyé, job rejoué, message NON déclaré inconnu", async () => {
    const { gateway, provider, run } = setup();
    gateway.claimResult = { status: "in_progress" };
    await expect(run({ attempt: 1 })).rejects.toThrow("send_in_progress");
    await run({ attempt: 5, maxAttempts: 5 });
    expect(provider.sent).toHaveLength(0);
    expect(gateway.failed).toHaveLength(0);
  });

  it("tentative déjà posée sans résultat connu : JAMAIS renvoyé, message « failed » / send_outcome_unknown", async () => {
    const { gateway, provider, run } = setup();
    gateway.claimResult = { status: "ambiguous" };
    await run();
    expect(provider.sent).toHaveLength(0);
    expect(gateway.failed).toEqual([{ code: "send_outcome_unknown" }]);
  });

  it("aucune réponse du fournisseur : « failed » / send_outcome_unknown, pas de nouvel essai automatique", async () => {
    const { gateway, provider, run } = setup();
    provider.outcome = { kind: "unknown", code: "no_response" };
    await run();
    expect(provider.sent).toHaveLength(1);
    expect(gateway.failed).toEqual([{ code: "send_outcome_unknown" }]);
    expect(gateway.released).toBe(0);
  });
});

describe("send_message : réponses du fournisseur", () => {
  it("refus définitif : message « failed » avec le code court, job réussi", async () => {
    const { gateway, provider, run } = setup();
    provider.outcome = { kind: "rejected", code: "recipient_inactive" };
    await run();
    expect(gateway.failed).toEqual([{ code: "recipient_inactive" }]);
    expect(gateway.released).toBe(0);
  });

  it("réponse « non accepté » : tentative libérée et job rejoué ; à la dernière tentative « failed »", async () => {
    const a = setup();
    a.provider.outcome = { kind: "retryable", code: "provider_unavailable" };
    await expect(a.run({ attempt: 2 })).rejects.toThrow("provider_unavailable");
    expect(a.gateway.released).toBe(1);
    expect(a.gateway.failed).toHaveLength(0);

    const b = setup();
    b.provider.outcome = { kind: "retryable", code: "provider_unavailable" };
    await b.run({ attempt: 5, maxAttempts: 5 });
    expect(b.gateway.failed).toEqual([{ code: "provider_unavailable" }]);
    expect(b.gateway.released).toBe(0);
  });

  it("l'enregistrement de l'acceptation survit à une panne brève de la base (le message n'est pas déclaré inconnu)", async () => {
    const { gateway, run } = setup();
    gateway.failAccept = 2;
    await run();
    expect(gateway.accepted).toEqual([{ providerMessageId: "pm-123" }]);
    expect(gateway.failed).toHaveLength(0);
  });
});

describe("send_message : jeton du fournisseur", () => {
  it("sans secret : « failed » / no_credentials, aucun appel", async () => {
    const { gateway, provider, run } = setup(async () => null);
    await run();
    expect(provider.sent).toHaveLength(0);
    expect(gateway.failed).toEqual([{ code: "no_credentials" }]);
  });

  it("lecture du secret en panne : tentative libérée, job rejoué, rien d'envoyé", async () => {
    const { gateway, provider, run } = setup(async () => { throw new Error("secret_lookup_failed"); });
    await expect(run()).rejects.toThrow("secret_lookup_failed");
    expect(gateway.released).toBe(1);
    expect(provider.sent).toHaveLength(0);
    expect(gateway.failed).toHaveLength(0);
  });

  it("arrêt demandé avant l'appel : tentative libérée, rien d'envoyé", async () => {
    const { gateway, provider, run } = setup();
    const abort = new AbortController();
    abort.abort();
    await expect(run({ signal: abort.signal })).rejects.toThrow("aborted");
    expect(gateway.released).toBe(1);
    expect(provider.sent).toHaveLength(0);
  });
});

describe("send_message : aucune fuite", () => {
  it("les codes enregistrés ne contiennent ni jeton, ni adresse, ni corps", async () => {
    const cases: Array<() => Promise<MemorySend>> = [
      async () => { const s = setup(); s.provider.outcome = { kind: "rejected", code: "recipient_invalid" }; await s.run(); return s.gateway; },
      async () => { const s = setup(); s.gateway.claimResult = claimedOk({ consent: false }); await s.run(); return s.gateway; },
      async () => { const s = setup(); s.provider.outcome = { kind: "unknown", code: "no_response" }; await s.run(); return s.gateway; },
    ];
    for (const make of cases) {
      const gateway = await make();
      const text = JSON.stringify([gateway.calls, gateway.failed]);
      expect(text).not.toContain("tok-SECRET");
      expect(text).not.toContain("karim@example.test");
      expect(text).not.toContain("Voici notre offre");
    }
  });
});
