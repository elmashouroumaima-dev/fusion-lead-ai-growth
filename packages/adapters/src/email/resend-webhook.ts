import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { normalizeContactEmail } from "@fusion-leap/domain";
import type { WebhookAdapter, WebhookHeaders } from "../webhooks/types";
import type { EmailEvent } from "./events";

/**
 * Adaptateur de webhook e-mail pour Resend (ADR 008, note du 2026-11-23). Contrairement à Postmark, Resend SIGNE ses webhooks (Svix) : en-têtes
 * `svix-id`, `svix-timestamp`, `svix-signature` (`v1,<base64>`, éventuellement répété et séparé par des espaces) ; le secret `whsec_<base64>` est celui
 * que Resend affiche à la création du webhook (l'utilisateur le colle comme « secret de webhook » de l'intégration). Signature = HMAC-SHA256 en base64
 * de `${svix-id}.${svix-timestamp}.${corps brut}`, clé = partie après `whsec_` décodée de base64. Algorithme du standard Svix ; la doc de Resend renvoie
 * à la bibliothèque Svix sans le détailler : À CONFIRMER sur un compte réel.
 *
 * Entreprise : le compte de l'intégration est `resend-<domaine de l'expéditeur>` (même règle que l'écran de connexion), lu dans `data.from` du corps
 * NON authentifié : il ne sert qu'à retrouver l'intégration et son secret ; un faux compte échoue à la signature.
 * Traités : `email.delivered`, `email.bounced`, `email.complained`. Tout autre événement d'e-mail (sent, opened, clicked, failed...) est ACQUITTÉ puis ignoré.
 * Traité aussi : `email.received` (la charge utile n'a pas le corps : le worker le relit par l'API de réception avec la clé de l'intégration, voir `resend-receive.ts`). Le compte est alors le domaine de l'adresse qui a REÇU le message.
 * Identifiant d'événement : dérivé du contenu (les retries ont le même corps), jamais d'un en-tête.
 */
const MAX_BYTES = 1024 * 1024;
const PROVIDER_ID = /^[A-Za-z0-9._:=+/@<>$%-]{1,998}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SVIX_ID = /^[A-Za-z0-9_.-]{1,200}$/;
const SIGNATURE_HEADER_MAX = 1000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const short = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Identifiant de compte d'une intégration Resend : même règle que `emailAccountId(sender, "resend")` de l'écran de connexion (à garder identique). */
export function resendAccountId(sender: string): string {
  return `resend-${sender.slice(sender.lastIndexOf("@") + 1).toLowerCase().replace(/[^a-z0-9._-]/g, "-")}`.slice(0, 100);
}

/**
 * UNE seule adresse, ou `null` (S-07). Formes acceptées : « a@b.test », « Nom <a@b.test> », « "Nom, avec virgule" <a@b.test> ». Refusées : plusieurs adresses
 * (virgule ou point-virgule hors d'un nom entre guillemets), commentaire entre parenthèses, nom non guillemeté contenant « @ », « < » ou « > », texte après « > ».
 * Pourquoi : le fournisseur évalue DMARC sur UNE adresse ; une liste « A <a@pirate.test>, V <v@client.test> » pouvait faire retenir l'adresse de la victime avec le résultat
 * « pass » de l'autre (usurpation d'un contact). Le résultat est l'adresse normalisée.
 */
export function resendAddressOf(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 400) return null;
  const text = value.trim();
  // nom guillemeté (guillemets échappés permis) ou nom simple SANS « @ », « , », « ; », « < », « > », « " », « ( » ni « ) »
  const angled = /^(?:"(?:[^"\\]|\\.)*"|[^<>",;@()]*)\s*<([^<>\s,;"()]+)>$/.exec(text);
  const candidate = angled ? (angled[1] ?? "") : /^[^\s<>",;()\\]+$/.test(text) ? text : null;
  if (candidate === null) return null;
  const normalized = normalizeContactEmail(candidate);
  return normalized.ok ? normalized.value : null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function refOf(tags: unknown): string | null {
  if (!isRecord(tags)) return null;
  const value = tags.fusion_message_id;
  return typeof value === "string" && UUID.test(value) ? value : null;
}

/** Forme conservée : l'événement normalisé + le compte (lu par `extractAccount`, ignoré par `readEmailEvent`). */
export type ResendNormalized = EmailEvent & { account: string | null };

/** Lit un payload Resend ; `null` si ce n'est pas un événement d'e-mail exploitable. */
export function normalizeResendPayload(raw: unknown): ResendNormalized | null {
  if (!isRecord(raw) || typeof raw.type !== "string" || !isRecord(raw.data)) return null;
  const type = raw.type;
  const data = raw.data;
  if (!/^[a-z_.]{3,60}$/.test(type)) return null;
  // événement qui n'est pas d'e-mail (domaine, contact, suppression...) : acquitté et ignoré, jamais refusé (un 400 ferait réessayer puis désactiver le webhook) (S-06)
  if (!type.startsWith("email.")) return { kind: "ignored", eventId: `ignored:${short(`${type}|${String(raw.created_at)}`)}`, recordType: type.replace(/[^A-Za-z]/g, "").slice(0, 40) || "other", account: null };
  // `email.received` : le « From » est le CLIENT ; le compte de l'intégration est le domaine de l'adresse qui a REÇU le message
  if (type === "email.received") {
    const received = Array.isArray(data.received_for) && data.received_for.length > 0 ? data.received_for : Array.isArray(data.to) ? data.to : [];
    const target = resendAddressOf(received[0]);
    const receivedId = typeof data.email_id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(data.email_id) ? data.email_id : null;
    if (target === null || receivedId === null) return null;
    return { kind: "inbound_fetch", eventId: `rs-rcv:${receivedId}`, emailId: receivedId, at: isoOrNull(raw.created_at), account: resendAccountId(target) };
  }
  const from = resendAddressOf(data.from);
  const account = from === null ? null : resendAccountId(from);
  const emailId = typeof data.email_id === "string" && PROVIDER_ID.test(data.email_id) ? data.email_id : null;
  const recipient = Array.isArray(data.to) ? resendAddressOf(data.to[0]) : null;
  const at = isoOrNull(raw.created_at);

  if (type === "email.delivered" || type === "email.bounced" || type === "email.complained") {
    if (emailId === null || recipient === null) return null;
    const ref = refOf(data.tags);
    const eventId = `rs-${type.slice(6, 9)}:${emailId}:${short(`${type}|${recipient}|${String(raw.created_at)}`)}`;
    if (type === "email.delivered") return { kind: "delivered", eventId, providerMessageId: emailId, recipient, at, ref, account };
    if (type === "email.complained") return { kind: "complaint", eventId, providerMessageId: emailId, recipient, at, ref, account };
    // rebond DUR seulement si le fournisseur le dit (`bounce.type` = « Permanent ») ; À CONFIRMER sur un compte réel
    const bounce = isRecord(data.bounce) ? data.bounce : null;
    return { kind: "bounced", eventId, hard: bounce !== null && bounce.type === "Permanent", providerMessageId: emailId, recipient, at, ref, account };
  }

  // autre événement d'e-mail : acquitté, jamais traité
  const recordType = type.replace(/[^A-Za-z]/g, "").slice(0, 40);
  if (recordType.length === 0) return null;
  return { kind: "ignored", eventId: `ignored:${short(`${type}|${emailId ?? ""}|${String(raw.created_at)}`)}`, recordType, account };
}

/** Clé de signature : la partie après `whsec_`, décodée de base64 ; `null` si le secret n'a pas cette forme. */
function signingKey(secret: string): Buffer | null {
  if (!secret.startsWith("whsec_")) return null;
  const encoded = secret.slice(6);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const key = Buffer.from(encoded, "base64");
  return key.length > 0 ? key : null;
}

export const resendWebhookAdapter: WebhookAdapter = {
  provider: "resend",
  storeProvider: "email",
  gateway: "resend",
  maxBytes: MAX_BYTES,
  parse(rawBody) {
    try {
      return normalizeResendPayload(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)));
    } catch {
      return null;
    }
  },
  // sans compte lisible (autre type d'événement, expéditeur introuvable) : rien d'exploitable, acquitté sans écriture (S-06)
  isIrrelevant: (payload) => isRecord(payload) && payload.account === null,
  extractAccount(payload) {
    return isRecord(payload) && typeof payload.account === "string" ? payload.account : null;
  },
  extractEventId(payload) {
    return isRecord(payload) && typeof payload.eventId === "string" ? payload.eventId : null;
  },
  extractTimestamp(_payload, headers) {
    const value = headers["svix-timestamp"];
    return typeof value === "string" && /^[0-9]{1,12}$/.test(value) ? Number(value) : null;
  },
  verify({ rawBody, headers, secret }) {
    const h = headers as WebhookHeaders;
    const id = h["svix-id"];
    const timestamp = h["svix-timestamp"];
    const signatures = h["svix-signature"];
    if (secret === null || typeof id !== "string" || !SVIX_ID.test(id) || typeof timestamp !== "string" || !/^[0-9]{1,12}$/.test(timestamp)) return false;
    if (typeof signatures !== "string" || signatures.length === 0 || signatures.length > SIGNATURE_HEADER_MAX) return false;
    const key = signingKey(secret);
    if (key === null) return false;
    const expected = createHmac("sha256", key).update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`, "utf8"), Buffer.from(rawBody)])).digest();
    // plusieurs signatures possibles (rotation du secret) : une seule doit correspondre ; comparaison à temps constant sur des octets de même longueur
    let ok = false;
    for (const part of signatures.split(" ")) {
      const match = /^v1,([A-Za-z0-9+/]+={0,2})$/.exec(part);
      if (!match || !match[1]) continue;
      const given = Buffer.from(match[1], "base64");
      if (given.length === expected.length && timingSafeEqual(given, expected)) ok = true;
    }
    return ok;
  },
};
