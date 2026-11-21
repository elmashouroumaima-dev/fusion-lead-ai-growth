import { createHash } from "node:crypto";
import { verifyHmacSha256Hex } from "../webhooks/hmac";
import type { WebhookAdapter, WebhookHeaders } from "../webhooks/types";
import { createWhatsAppCloudClient, type WhatsAppCloudOptions } from "./cloud";
import { readWhatsAppPayload, WHATSAPP_EVENTS_MAX, WHATSAPP_TEXT_MAX, type WhatsAppEvent, type WhatsAppPayload, type WhatsAppStatus } from "./events";
import { createWhatsAppSender, type WhatsAppGateway, type WhatsAppSender, type WhatsAppSenderOptions, type WhatsAppSendInput, type WhatsAppSendOutcome } from "./send";

/**
 * Passerelle WhatsApp Kapso (ADR 017, décision du 2026-11-21) : Kapso relaie l'API Cloud OFFICIELLE de Meta (même corps de requête et de réponse), avec une autre
 * adresse et une clé d'API dans l'en-tête `X-API-Key` au lieu du jeton `Bearer`. Adresse FIXE (jamais saisie : pas de requête sortante vers un hôte choisi par un
 * utilisateur). Le secret de l'intégration est la clé d'API de Kapso ; le secret de webhook est la `secret_key` que NOUS choisissons à l'enregistrement du webhook.
 * HYPOTHÈSES À CONFIRMER au checkpoint C3 (documentation de Kapso de 2 à 5 mois) : version et chemin de l'adresse, route de vérification d'un numéro, codes d'erreur
 * (ceux de Meta sont supposés relayés tels quels), format exact des événements (voir `normalizeKapsoPayload`).
 */
export const KAPSO_BASE = "https://api.kapso.ai/meta/whatsapp/v24.0";
const kapsoAuth = (token: string): Record<string, string> => ({ "X-API-Key": token });

/** Envoi par Kapso : même contrat et mêmes résultats que l'envoi direct (`accepted` / `rejected` / `retryable` / `unknown`). */
export function createKapsoSender(options: Pick<WhatsAppSenderOptions, "fetch" | "timeoutMs"> = {}): WhatsAppSender {
  return createWhatsAppSender({ ...options, base: KAPSO_BASE, name: "whatsapp_kapso", authHeaders: kapsoAuth });
}

/** Vérification d'une clé d'API et d'un numéro Kapso : mêmes codes courts que Meta (`provider_auth`, `provider_account`, `provider_unavailable`, `provider_unreadable`). */
export function createKapsoClient(options: Pick<WhatsAppCloudOptions, "fetch" | "timeoutMs"> = {}) {
  return createWhatsAppCloudClient({ ...options, base: KAPSO_BASE, authHeaders: kapsoAuth });
}
export type KapsoClient = ReturnType<typeof createKapsoClient>;

/** Envoi par la passerelle de l'intégration : `meta` par défaut (comportement historique), `kapso` si le worker l'indique. */
export function createWhatsAppGatewaySender(senders: { meta: WhatsAppSender; kapso: WhatsAppSender }): WhatsAppSender {
  return {
    name: "whatsapp_gateway",
    send(input: WhatsAppSendInput, accessToken: string): Promise<WhatsAppSendOutcome> {
      const gateway: WhatsAppGateway = input.gateway === "kapso" ? "kapso" : "meta";
      return senders[gateway].send(input, accessToken);
    },
  };
}

// ---------------------------------------------------------------------------
// Webhooks de type « kapso » (charge utile v2) : signature et analyse
// ---------------------------------------------------------------------------
const PHONE_NUMBER_ID = /^[0-9]{5,30}$/;
const MESSAGE_ID = /^[A-Za-z0-9._=+/-]{1,255}$/;
const FROM = /^[0-9]{5,20}$/;
const TYPE = /^[a-z_]{1,30}$/;
const STATUSES = ["sent", "delivered", "read", "failed"] as const;
const NOT_MESSAGES = new Set(["reaction", "system", "request_welcome"]);
const BATCH_MAX = 100;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function cleanText(value: string, max: number): string {
  const wellFormed = value.replaceAll("\u0000", "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
  return wellFormed.length <= max ? wellFormed : Array.from(wellFormed).slice(0, max).join("");
}

/** Horodatage Kapso : secondes Unix en chaîne (10 chiffres au plus) -> ISO, ou null. */
function isoFromSeconds(value: unknown): string | null {
  const text = typeof value === "number" && Number.isInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !/^[0-9]{9,10}$/.test(text)) return null;
  const date = new Date(Number(text) * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * Texte d'un message reçu : le texte lui-même, ou le libellé d'un bouton / d'une réponse interactive (même règle que pour Meta : un « STOP » tapé sur un bouton
 * ne doit pas se perdre). Un message sans texte (image, audio...) n'en a pas : seul son type est conservé.
 */
function messageText(type: string, message: Record<string, unknown>): string | null {
  let raw: unknown = null;
  if (type === "text" && isRecord(message.text)) raw = message.text.body;
  else if (type === "button" && isRecord(message.button)) raw = message.button.text;
  else if (type === "interactive" && isRecord(message.interactive)) {
    const reply = isRecord(message.interactive.button_reply) ? message.interactive.button_reply : isRecord(message.interactive.list_reply) ? message.interactive.list_reply : null;
    raw = reply?.title;
  }
  if (typeof raw !== "string") return null;
  const cleaned = cleanText(raw, WHATSAPP_TEXT_MAX);
  return cleaned.length > 0 ? cleaned : null;
}

/** Numéro du contact d'un événement sans message : cherché dans les emplacements documentés (chiffres avec ou sans « + » ; jamais un identifiant autre que numérique). */
function contactPhone(item: Record<string, unknown>): string | null {
  const contact = isRecord(item.contact) ? item.contact : {};
  const conversation = isRecord(item.conversation) ? item.conversation : {};
  for (const candidate of [contact.phone_number, contact.wa_id, contact.phone, conversation.phone_number, item.phone_number, item.wa_id]) {
    if (typeof candidate === "string") {
      const digits = candidate.replace(/^\+/, "");
      if (FROM.test(digits)) return `+${digits}`;
    }
  }
  return null;
}

/**
 * Corps d'un webhook Kapso (JSON déjà lu) -> MÊME forme normalisée que Meta (`WhatsAppPayload`) : le worker et la base ne changent pas, et seule cette forme réduite
 * est conservée (jamais le corps brut, les profils ni les médias). Reconnaît, d'après le CONTENU (l'en-tête `X-Webhook-Event` n'est pas signé) :
 *  - un message reçu (`message.kapso.direction = "inbound"`), avec son texte ; le numéro de l'expéditeur (`from`, chiffres avec ou sans « + ») devient `+<chiffres>` ;
 *  - un statut de NOTRE message (`direction = "outbound"`, `kapso.status` parmi sent, delivered, read, failed), avec le code d'erreur numérique (jamais son texte) ;
 *  - le lot (`batch: true`, `data: [...]`), que Kapso utilise pour tous les envois quand la mise en lot est activée ;
 *  - tout le reste (conversations, contacts, fils partagés...) est ignoré et compté.
 * `null` si la structure n'est pas celle d'un webhook Kapso, ou si la requête mélange plusieurs numéros (une signature = une intégration).
 */
export function normalizeKapsoPayload(raw: unknown): WhatsAppPayload | null {
  if (!isRecord(raw)) return null;
  const items: unknown[] = raw.batch === true ? (Array.isArray(raw.data) ? raw.data : []) : [raw];
  if (items.length === 0 || items.length > BATCH_MAX) return null;
  const phoneNumberIds = new Set<string>();
  const events: WhatsAppEvent[] = [];
  let skipped = 0;
  for (const item of items) {
    if (!isRecord(item)) return null;
    const id = item.phone_number_id;
    if (typeof id !== "string" || !PHONE_NUMBER_ID.test(id)) return null;
    phoneNumberIds.add(id);
    // préférence marketing d'un contact (STOP annoncé par WhatsApp) : événement SANS message, reconnu d'après son contenu
    const preference = item.marketing_preference;
    if (isRecord(preference) && (preference.status === "stopped" || preference.status === "resumed")) {
      const phone = contactPhone(item);
      if (phone === null) {
        skipped += 1;
        continue;
      }
      const sequence = typeof preference.sequence === "number" && Number.isInteger(preference.sequence) && preference.sequence >= 0 ? String(preference.sequence) : "0";
      const at = typeof preference.occurred_at === "string" && !Number.isNaN(Date.parse(preference.occurred_at)) ? new Date(preference.occurred_at).toISOString() : null;
      events.push({ kind: "marketing_preference", id: `mp.${phone.slice(1)}.${preference.status}.${sequence}`, from: phone, at, status: preference.status });
      continue;
    }
    const message = item.message;
    if (!isRecord(message) || !isRecord(message.kapso) || typeof message.id !== "string" || !MESSAGE_ID.test(message.id)) {
      skipped += 1;
      continue;
    }
    const kapso = message.kapso;
    if (kapso.direction === "inbound") {
      const fromRaw = typeof message.from === "string" ? message.from.replace(/^\+/, "") : "";
      const type = typeof message.type === "string" && TYPE.test(message.type) ? message.type : "unknown";
      if (!FROM.test(fromRaw) || NOT_MESSAGES.has(type)) {
        skipped += 1;
        continue;
      }
      const body = messageText(type, message);
      events.push({ kind: "message", id: message.id, from: `+${fromRaw}`, at: isoFromSeconds(message.timestamp), type, text: body && body.length > 0 ? body : null });
    } else if (kapso.direction === "outbound") {
      const status = (STATUSES as readonly unknown[]).find((s) => s === kapso.status) as WhatsAppStatus | undefined;
      if (status === undefined) {
        skipped += 1;
        continue;
      }
      const entries = Array.isArray(kapso.statuses) ? kapso.statuses.filter(isRecord) : [];
      const current = entries.find((e) => e.status === status);
      const errors = current && Array.isArray(current.errors) ? current.errors : [];
      const first = isRecord(errors[0]) ? errors[0].code : null;
      events.push({
        kind: "status", id: message.id, status, at: isoFromSeconds(current?.timestamp ?? message.timestamp),
        errorCode: typeof first === "number" && Number.isInteger(first) && first >= 0 && first <= 999_999 ? first : null,
      });
    } else {
      skipped += 1;
    }
    if (events.length > WHATSAPP_EVENTS_MAX) return null;
  }
  if (phoneNumberIds.size !== 1) return null;
  return { object: "whatsapp_business_account", phoneNumberIds: [...phoneNumberIds], events, skipped };
}

/**
 * Adaptateur de webhook Kapso (`POST /api/webhooks/kapso`). Kapso signe le corps BRUT : HMAC-SHA256 hexadécimal SANS préfixe dans `X-Webhook-Signature`, clé = la
 * `secret_key` choisie par nous (secret de webhook de l'intégration). Les événements sont conservés sous le fournisseur `whatsapp` (même table, même processeur du
 * worker) mais la résolution ne retrouve qu'une intégration de passerelle `kapso`. Déduplication : empreinte de la forme normalisée (contenu signé) ; l'en-tête
 * `X-Idempotency-Key` n'est PAS signé, il n'est donc pas utilisé (contrat de `types.ts`).
 */
export const kapsoWebhookAdapter: WebhookAdapter = {
  provider: "kapso",
  storeProvider: "whatsapp",
  gateway: "kapso",
  maxBytes: 3 * 1024 * 1024,
  parse(rawBody) {
    try {
      return normalizeKapsoPayload(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)));
    } catch {
      return null;
    }
  },
  extractAccount(payload) {
    const parsed = readWhatsAppPayload(payload);
    return parsed ? (parsed.phoneNumberIds[0] ?? null) : null;
  },
  extractEventId(payload) {
    if (readWhatsAppPayload(payload) === null) return null;
    return `kp:${createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 40)}`;
  },
  verify({ rawBody, headers, secret }) {
    return verifyHmacSha256Hex({ secret, rawBody, signature: (headers as WebhookHeaders)["x-webhook-signature"], prefix: "" });
  },
};
