/**
 * Chaîne de contrôles d'un envoi sortant (J31, spec §5.7 et §9.2, figure 9, menaces B3 et C3). Fonction PURE : le worker lit l'état en base
 * (`message_send_claim`), appelle `checkCanSend` JUSTE avant l'appel au fournisseur et n'appelle le fournisseur que sur `ok: true`.
 * Échec fermé : toute donnée absente ou inattendue refuse l'envoi. Le premier contrôle qui échoue décide (ordre fixe ci-dessous).
 */
export const SEND_REFUSAL_REASONS = [
  "not_approved",
  "approval_invalid",
  "approval_stale",
  "no_purpose",
  "organization_inactive",
  "organization_paused",
  "channel_paused",
  "channel_inactive",
  "no_recipient",
  "recipient_changed",
  "do_not_contact",
  "suppressed",
  "no_consent",
  "template_missing",
  "rate_limited",
] as const;
/** Une approbation humaine ne vaut que 72 heures : au-delà, un humain doit la renouveler (message `failed`). */
export const APPROVAL_MAX_AGE_SECONDS = 72 * 3600;

export type SendRefusalReason = (typeof SEND_REFUSAL_REASONS)[number];

export type SendCheckInput = {
  /** Approbation humaine habilitée présente (`approved_by` posé par `message_approve`). */
  approved: boolean;
  /** Revalidation de l'approbation À L'ENVOI : l'approbateur est toujours owner / admin actif, l'approbation n'est pas périmée, l'adresse n'a pas changé. */
  approval: { validApprover: boolean; ageSeconds: number | null; recipientUnchanged: boolean };
  /** Finalité approuvée (« marketing », « service »…). */
  purpose: string | null;
  /** Entreprise active ET abonnement actif (ni suspendu, ni annulé). */
  organizationActive: boolean;
  organizationSendPaused: boolean;
  channel: { status: string; sendPaused: boolean; integrationStatus: string };
  /** Adresse du destinataire, tirée du CONTACT du fil (jamais d'un champ libre). */
  recipient: string | null;
  doNotContact: boolean;
  suppressed: boolean;
  /** Consentement actif (non révoqué) du contact pour ce canal ET cette finalité. */
  consent: boolean;
  /** E-mail : `required` = false ; WhatsApp hors fenêtre (J36) : `required` = true et `approved` = statut du modèle. */
  template: { required: boolean; approved: boolean };
  rate: { sentInWindow: number; limit: number };
};

export type SendCheckResult = { ok: true } | { ok: false; reason: SendRefusalReason };

export function checkCanSend(input: SendCheckInput): SendCheckResult {
  const refuse = (reason: SendRefusalReason): SendCheckResult => ({ ok: false, reason });
  // 1. approbation humaine et finalité
  if (input.approved !== true) return refuse("not_approved");
  if (input.approval.validApprover !== true) return refuse("approval_invalid");
  if (typeof input.approval.ageSeconds !== "number" || !Number.isFinite(input.approval.ageSeconds) || input.approval.ageSeconds < 0 || input.approval.ageSeconds > APPROVAL_MAX_AGE_SECONDS) {
    return refuse("approval_stale");
  }
  if (typeof input.purpose !== "string" || input.purpose.length === 0) return refuse("no_purpose");
  // 2. entreprise active, arrêts d'urgence (entreprise, canal) et état du canal
  if (input.organizationActive !== true) return refuse("organization_inactive");
  if (input.organizationSendPaused !== false) return refuse("organization_paused");
  if (input.channel.sendPaused !== false) return refuse("channel_paused");
  if (input.channel.status !== "active" || input.channel.integrationStatus !== "active") return refuse("channel_inactive");
  // 3. destinataire, ne plus contacter, suppression, consentement
  if (typeof input.recipient !== "string" || input.recipient.length === 0) return refuse("no_recipient");
  if (input.approval.recipientUnchanged !== true) return refuse("recipient_changed");
  if (input.doNotContact !== false) return refuse("do_not_contact");
  if (input.suppressed !== false) return refuse("suppressed");
  if (input.consent !== true) return refuse("no_consent");
  // 4. modèle approuvé si requis
  if (input.template.required && !input.template.approved) return refuse("template_missing");
  // 5. limite de débit
  if (!Number.isInteger(input.rate.sentInWindow) || !Number.isInteger(input.rate.limit) || input.rate.sentInWindow >= input.rate.limit) {
    return refuse("rate_limited");
  }
  return { ok: true };
}

export class SendRefusedError extends Error {
  readonly reason: SendRefusalReason;
  constructor(reason: SendRefusalReason) {
    super(`send_refused_${reason}`);
    this.name = "SendRefusedError";
    this.reason = reason;
  }
}

/** Variante qui lève `SendRefusedError` (le message ne contient que le code de refus). */
export function assertCanSend(input: SendCheckInput): void {
  const result = checkCanSend(input);
  if (!result.ok) throw new SendRefusedError(result.reason);
}

/** Un refus est DÉFINITIF (le message passe en `failed`) sauf la limite de débit, qui se rejoue plus tard. */
export function isRetryableRefusal(reason: SendRefusalReason): boolean {
  return reason === "rate_limited";
}

/** Limite provisoire d'envois par canal et par heure, en attendant le limiteur par fournisseur du J39 (décision de la responsable technique). */
export const EMAIL_SENDS_PER_HOUR = 100;
/** Limite PROVISOIRE d'envois WhatsApp par heure et par canal (J36) : à fixer avec le palier de messagerie de Meta et le plan de l'entreprise. */
export const WHATSAPP_SENDS_PER_HOUR = 100;

/** Objet de l'e-mail (la table des messages n'a pas de sujet avant les modèles du J40) : première ligne non vide du corps, 120 caractères au plus. */
export function deriveEmailSubject(body: string): string {
  const firstLine = body.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  // un objet ne contient jamais de caractère de contrôle
  // eslint-disable-next-line no-control-regex
  const cleaned = firstLine.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "(sans objet)";
}
