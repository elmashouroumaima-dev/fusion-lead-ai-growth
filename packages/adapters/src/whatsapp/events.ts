/**
 * Événements WhatsApp normalisés (J35, spec §9.3). La route publique (J29) lit le corps de Meta UNE fois, le réduit à ce qui sert (messages reçus
 * et statuts de NOS messages) puis conserve cette forme dans `webhook_events.payload` : ni profils des contacts, ni médias, ni boutons, ni le corps
 * brut de 3 Mo. Le worker relit cette forme (`readWhatsAppPayload`) ; autre chose = base altérée.
 *  - un message reçu : `from` (numéro en chiffres, devient `+<chiffres>`), type, texte (4096 au plus) ; un message non textuel (image, audio...)
 *    garde seulement son type, sans média ;
 *  - un statut : `sent`, `delivered`, `read` ou `failed` (avec le code d'erreur numérique de Meta, jamais son texte) ;
 *  - les autres notifications (état du compte, qualité du numéro, modèles) sont ignorées ; un élément mal formé est écarté et compté.
 * Les identifiants viennent du fournisseur (`wamid...`) et servent à dédupliquer : le même message n'est jamais enregistré deux fois.
 */
export const WHATSAPP_TEXT_MAX = 4096;
export const WHATSAPP_EVENTS_MAX = 1000;
const PHONE_NUMBER_ID = /^[0-9]{5,30}$/;
const MESSAGE_ID = /^[A-Za-z0-9._=+/-]{1,255}$/;
const FROM = /^[0-9]{5,20}$/;
const TYPE = /^[a-z_]{1,30}$/;
const STATUSES = ["sent", "delivered", "read", "failed"] as const;
/** Types qui ne sont pas des messages de conversation : une réaction ou un événement système ne crée pas de message et ne rouvre pas le fil. */
const NOT_MESSAGES = new Set(["reaction", "system", "request_welcome"]);

export type WhatsAppStatus = (typeof STATUSES)[number];
export type WhatsAppEvent =
  | { kind: "message"; id: string; from: string; at: string | null; type: string; text: string | null }
  | { kind: "status"; id: string; status: WhatsAppStatus; at: string | null; errorCode: number | null };
export type WhatsAppPayload = { object: "whatsapp_business_account"; phoneNumberIds: string[]; events: WhatsAppEvent[]; skipped: number };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** NUL retirés (refusés par Postgres), surrogates isolés remplacés, coupé par point de code. */
function cleanText(value: string, max: number): string {
  const wellFormed = value.replaceAll("\u0000", "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
  return wellFormed.length <= max ? wellFormed : Array.from(wellFormed).slice(0, max).join("");
}

/** Horodatage Meta (secondes Unix en chaîne) -> ISO, ou null. */
function isoFromSeconds(value: unknown): string | null {
  // 10 chiffres au plus (année 2286) : au-delà, la date ne passerait pas le stockage et ferait échouer tout le lot
  if (typeof value !== "string" || !/^[0-9]{9,10}$/.test(value)) return null;
  const date = new Date(Number(value) * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * Texte d'un message : le texte lui-même, ou le libellé d'un bouton / d'une réponse interactive (un « STOP » tapé sur un bouton ne doit pas se perdre en
 * « [button] »). Un message sans texte (image, audio...) n'en a pas : seul son type est conservé.
 */
function messageText(type: string, item: Record<string, unknown>): string | null {
  let raw: unknown = null;
  if (type === "text" && isRecord(item.text)) raw = item.text.body;
  else if (type === "button" && isRecord(item.button)) raw = item.button.text;
  else if (type === "interactive" && isRecord(item.interactive)) {
    const reply = isRecord(item.interactive.button_reply) ? item.interactive.button_reply : isRecord(item.interactive.list_reply) ? item.interactive.list_reply : null;
    raw = reply?.title;
  }
  return typeof raw === "string" ? cleanText(raw, WHATSAPP_TEXT_MAX) : null;
}

/** Corps de Meta (JSON déjà lu) -> forme normalisée, ou `null` si la structure n'est pas celle d'un webhook WhatsApp. Jamais d'exception. */
export function normalizeWhatsAppPayload(raw: unknown): WhatsAppPayload | null {
  if (!isRecord(raw) || raw.object !== "whatsapp_business_account" || !Array.isArray(raw.entry) || raw.entry.length === 0 || raw.entry.length > 100) return null;
  const phoneNumberIds = new Set<string>();
  const events: WhatsAppEvent[] = [];
  let skipped = 0;
  for (const entry of raw.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes) || entry.changes.length === 0 || entry.changes.length > 100) return null;
    for (const change of entry.changes) {
      if (!isRecord(change) || !isRecord(change.value)) return null;
      const value = change.value;
      // d'autres notifications de Meta n'ont pas de numéro : seuls les changements AVEC un numéro désignent l'intégration
      if (isRecord(value.metadata) && value.metadata.phone_number_id !== undefined) {
        const id = value.metadata.phone_number_id;
        if (typeof id !== "string" || !PHONE_NUMBER_ID.test(id)) return null;
        phoneNumberIds.add(id);
      }
      if (change.field !== "messages") continue;
      const rawMessages = Array.isArray(value.messages) ? value.messages : [];
      const rawStatuses = Array.isArray(value.statuses) ? value.statuses : [];
      skipped += Math.max(0, rawMessages.length - WHATSAPP_EVENTS_MAX) + Math.max(0, rawStatuses.length - WHATSAPP_EVENTS_MAX);
      for (const item of rawMessages.slice(0, WHATSAPP_EVENTS_MAX)) {
        if (!isRecord(item) || typeof item.id !== "string" || !MESSAGE_ID.test(item.id) || typeof item.from !== "string" || !FROM.test(item.from)) {
          skipped += 1;
          continue;
        }
        const type = typeof item.type === "string" && TYPE.test(item.type) ? item.type : "unknown";
        if (NOT_MESSAGES.has(type)) {
          skipped += 1;
          continue;
        }
        const body = messageText(type, item);
        events.push({ kind: "message", id: item.id, from: `+${item.from}`, at: isoFromSeconds(item.timestamp), type, text: body && body.length > 0 ? body : null });
      }
      for (const item of rawStatuses.slice(0, WHATSAPP_EVENTS_MAX)) {
        const status = isRecord(item) ? (STATUSES as readonly unknown[]).find((s) => s === item.status) : undefined;
        if (!isRecord(item) || typeof item.id !== "string" || !MESSAGE_ID.test(item.id) || status === undefined) {
          skipped += 1;
          continue;
        }
        const first = Array.isArray(item.errors) && isRecord(item.errors[0]) ? item.errors[0].code : null;
        events.push({
          kind: "status", id: item.id, status: status as WhatsAppStatus, at: isoFromSeconds(item.timestamp),
          errorCode: typeof first === "number" && Number.isInteger(first) && first >= 0 && first <= 999_999 ? first : null,
        });
      }
      if (events.length > WHATSAPP_EVENTS_MAX) return null;
    }
  }
  return { object: "whatsapp_business_account", phoneNumberIds: [...phoneNumberIds], events, skipped };
}

/** Relit la forme conservée (celle que NOUS avons écrite) ; `null` si elle a été altérée. */
export function readWhatsAppPayload(value: unknown): WhatsAppPayload | null {
  if (!isRecord(value) || value.object !== "whatsapp_business_account" || !Array.isArray(value.phoneNumberIds) || !Array.isArray(value.events) || typeof value.skipped !== "number") return null;
  const ids = value.phoneNumberIds;
  if (ids.length !== 1 || typeof ids[0] !== "string" || !PHONE_NUMBER_ID.test(ids[0]) || value.events.length > WHATSAPP_EVENTS_MAX) return null;
  for (const event of value.events) {
    if (!isRecord(event) || typeof event.id !== "string" || !MESSAGE_ID.test(event.id)) return null;
    if (event.kind === "message") {
      if (typeof event.from !== "string" || !/^\+[0-9]{5,20}$/.test(event.from) || typeof event.type !== "string" || !TYPE.test(event.type)) return null;
      if (event.text !== null && (typeof event.text !== "string" || event.text.length === 0)) return null;
      if (event.at !== null && typeof event.at !== "string") return null;
    } else if (event.kind === "status") {
      if (!(STATUSES as readonly unknown[]).includes(event.status) || (event.errorCode !== null && typeof event.errorCode !== "number")) return null;
      if (event.at !== null && typeof event.at !== "string") return null;
    } else {
      return null;
    }
  }
  return value as unknown as WhatsAppPayload;
}
