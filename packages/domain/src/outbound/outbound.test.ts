import { describe, expect, it } from "vitest";
import { APPROVAL_MAX_AGE_SECONDS, assertCanSend, checkCanSend, deriveEmailSubject, isRetryableRefusal, SEND_REFUSAL_REASONS, SendRefusedError, type SendCheckInput } from "./send";

const good: SendCheckInput = {
  approved: true,
  approval: { validApprover: true, ageSeconds: 60, recipientUnchanged: true },
  purpose: "marketing",
  organizationActive: true,
  organizationSendPaused: false,
  channel: { status: "active", sendPaused: false, integrationStatus: "active" },
  recipient: "a@example.test",
  doNotContact: false,
  suppressed: false,
  consent: true,
  template: { required: false, approved: false },
  rate: { sentInWindow: 0, limit: 100 },
};

describe("checkCanSend (chaîne de contrôles, échec fermé)", () => {
  it("autorise quand tout est en règle", () => {
    expect(checkCanSend(good)).toEqual({ ok: true });
    expect(() => assertCanSend(good)).not.toThrow();
  });

  const cases: Array<[string, Partial<SendCheckInput>, string]> = [
    ["sans approbation humaine", { approved: false }, "not_approved"],
    ["approbateur plus owner / admin actif", { approval: { ...good.approval, validApprover: false } }, "approval_invalid"],
    ["approbation périmée (73 h)", { approval: { ...good.approval, ageSeconds: 73 * 3600 } }, "approval_stale"],
    ["âge d'approbation inconnu", { approval: { ...good.approval, ageSeconds: null } }, "approval_stale"],
    ["âge d'approbation négatif", { approval: { ...good.approval, ageSeconds: -1 } }, "approval_stale"],
    ["entreprise suspendue ou abonnement inactif", { organizationActive: false }, "organization_inactive"],
    ["adresse du contact modifiée depuis l'approbation", { approval: { ...good.approval, recipientUnchanged: false } }, "recipient_changed"],
    ["sans finalité", { purpose: null }, "no_purpose"],
    ["finalité vide", { purpose: "" }, "no_purpose"],
    ["entreprise en pause", { organizationSendPaused: true }, "organization_paused"],
    ["canal en pause", { channel: { ...good.channel, sendPaused: true } }, "channel_paused"],
    ["canal non actif", { channel: { ...good.channel, status: "pending" } }, "channel_inactive"],
    ["canal déconnecté", { channel: { ...good.channel, status: "disconnected" } }, "channel_inactive"],
    ["intégration en erreur", { channel: { ...good.channel, integrationStatus: "error" } }, "channel_inactive"],
    ["sans destinataire", { recipient: null }, "no_recipient"],
    ["destinataire vide", { recipient: "" }, "no_recipient"],
    ["ne plus contacter", { doNotContact: true }, "do_not_contact"],
    ["adresse supprimée", { suppressed: true }, "suppressed"],
    ["sans consentement", { consent: false }, "no_consent"],
    ["modèle requis mais non approuvé", { template: { required: true, approved: false } }, "template_missing"],
    ["limite de débit atteinte", { rate: { sentInWindow: 100, limit: 100 } }, "rate_limited"],
    ["limite de débit dépassée", { rate: { sentInWindow: 250, limit: 100 } }, "rate_limited"],
    ["compteur invalide", { rate: { sentInWindow: Number.NaN, limit: 100 } }, "rate_limited"],
  ];
  for (const [label, patch, reason] of cases) {
    it(`refuse : ${label} (${reason})`, () => {
      expect(checkCanSend({ ...good, ...patch })).toEqual({ ok: false, reason });
      expect(() => assertCanSend({ ...good, ...patch })).toThrow(SendRefusedError);
    });
  }

  it("une approbation de 72 h pile est encore valable", () => {
    expect(checkCanSend({ ...good, approval: { ...good.approval, ageSeconds: APPROVAL_MAX_AGE_SECONDS } })).toEqual({ ok: true });
  });

  it("un modèle requis et approuvé est accepté", () => {
    expect(checkCanSend({ ...good, template: { required: true, approved: true } })).toEqual({ ok: true });
  });

  it("échec fermé : une valeur inattendue (undefined, chaîne) refuse", () => {
    expect(checkCanSend({ ...good, approved: undefined as never })).toEqual({ ok: false, reason: "not_approved" });
    expect(checkCanSend({ ...good, doNotContact: undefined as never })).toEqual({ ok: false, reason: "do_not_contact" });
    expect(checkCanSend({ ...good, suppressed: "false" as never })).toEqual({ ok: false, reason: "suppressed" });
    expect(checkCanSend({ ...good, consent: "true" as never })).toEqual({ ok: false, reason: "no_consent" });
    expect(checkCanSend({ ...good, organizationSendPaused: undefined as never })).toEqual({ ok: false, reason: "organization_paused" });
    expect(checkCanSend({ ...good, organizationActive: undefined as never })).toEqual({ ok: false, reason: "organization_inactive" });
    expect(checkCanSend({ ...good, approval: { validApprover: "true" as never, ageSeconds: 1, recipientUnchanged: true } })).toEqual({ ok: false, reason: "approval_invalid" });
  });

  it("le premier contrôle qui échoue décide (approbation, puis ne plus contacter, suppression, consentement)", () => {
    const everythingWrong: SendCheckInput = {
      ...good, approved: false, consent: false, doNotContact: true, suppressed: true, rate: { sentInWindow: 999, limit: 100 },
    };
    expect(checkCanSend(everythingWrong)).toEqual({ ok: false, reason: "not_approved" });
    expect(checkCanSend({ ...everythingWrong, approved: true })).toEqual({ ok: false, reason: "do_not_contact" });
    expect(checkCanSend({ ...everythingWrong, approved: true, doNotContact: false })).toEqual({ ok: false, reason: "suppressed" });
    expect(checkCanSend({ ...everythingWrong, approved: true, doNotContact: false, suppressed: false })).toEqual({ ok: false, reason: "no_consent" });
  });

  it("l'erreur ne porte que le code de refus", () => {
    try {
      assertCanSend({ ...good, recipient: "secret@example.test", consent: false });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toBe("send_refused_no_consent");
      expect(JSON.stringify(error)).not.toContain("secret@example.test");
    }
  });

  it("seule la limite de débit se rejoue", () => {
    for (const reason of SEND_REFUSAL_REASONS) expect(isRetryableRefusal(reason)).toBe(reason === "rate_limited");
  });
});

describe("deriveEmailSubject", () => {
  it("prend la première ligne non vide", () => {
    expect(deriveEmailSubject("\n\n  Bonjour Karim  \nLe corps")).toBe("Bonjour Karim");
  });
  it("limite à 120 caractères et retire les caractères de contrôle", () => {
    expect(deriveEmailSubject("a".repeat(500))).toHaveLength(120);
    expect(deriveEmailSubject("Objet\u0000\u0007x")).toBe("Objet  x");
  });
  it("un corps sans texte donne « (sans objet) »", () => {
    expect(deriveEmailSubject("  \n \n")).toBe("(sans objet)");
  });
});
