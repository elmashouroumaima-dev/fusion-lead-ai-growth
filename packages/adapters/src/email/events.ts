import { createHash } from "node:crypto";
import { normalizeContactEmail } from "@fusion-leap/domain";

/**
 * Événements e-mail normalisés (J32, spec §9.2, ADR 008). Le webhook du fournisseur est lu UNE fois par `normalizePostmarkPayload` ; ce qui est
 * conservé (table `webhook_events`) est cette forme normalisée, réduite au strict nécessaire : ni pièces jointes, ni HTML, ni vidage complet
 * d'un rebond. Le worker relit la forme conservée avec `readEmailEvent` (aucune confiance dans la base : même contrôle de forme).
 *
 * Règles : un rebond est DUR seulement si le fournisseur le dit (TypeCode 1) ; `delivered` ne vient que d'un événement du fournisseur ;
 * un événement d'un autre type (ouverture, clic...) est ACQUITTÉ puis ignoré (jamais un refus : le fournisseur désactiverait le webhook).
 */
const PROVIDER_ID = /^[A-Za-z0-9._:=+/@<>$%-]{1,998}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVENT_ID = /^[A-Za-z0-9._:=+/@-]{1,200}$/;
export const EMAIL_BODY_MAX = 100_000;
const SUBJECT_MAX = 300;
const RECIPIENTS_MAX = 20;

export type EmailEvent =
  | { kind: "delivered"; eventId: string; providerMessageId: string; recipient: string; at: string | null; ref: string | null }
  | { kind: "bounced"; eventId: string; hard: boolean; providerMessageId: string; recipient: string; at: string | null; ref: string | null }
  | { kind: "complaint"; eventId: string; providerMessageId: string; recipient: string; at: string | null; ref: string | null }
  | {
      kind: "inbound";
      eventId: string;
      providerMessageId: string;
      from: string;
      recipients: string[];
      subject: string | null;
      body: string;
      at: string | null;
      /** L'expéditeur est authentifié pour l'adresse qu'il affiche : SPF « Pass » ALIGNÉ sur le domaine de « From », ou DKIM valide du domaine de l'auteur. */
      spfPass: boolean;
      /** `X-Spam-Status` à « Yes ». */
      spam: boolean;
    }
  | { kind: "ignored"; eventId: string; recordType: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const short = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

/**
 * Texte d'un e-mail prêt à être stocké : NUL retirés (refusés par Postgres), surrogates isolés remplacés (`toWellFormed`), coupé PAR POINT DE CODE
 * (jamais au milieu d'une paire). Un corps qui ne passerait pas le stockage ferait échouer l'enregistrement du webhook et le fournisseur
 * réessaierait jusqu'à perdre le message.
 */
function cleanText(value: string, max: number): string {
  // surrogate haut sans bas, ou bas sans haut : remplacé par U+FFFD (équivalent de `toWellFormed`)
  const wellFormed = value.replaceAll("\u0000", "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
  if (wellFormed.length <= max) return wellFormed;
  return Array.from(wellFormed).slice(0, max).join("");
}

/** Identifiant d'événement sûr pour la contrainte de `webhook_events` : l'identifiant du fournisseur tel quel s'il convient, sinon son empreinte. */
function eventKey(prefix: string, id: string): string {
  const direct = `${prefix}:${id}`;
  return EVENT_ID.test(direct) ? direct : `${prefix}:h${createHash("sha256").update(id).digest("hex").slice(0, 40)}`;
}

function isoOrNull(value: unknown): string | null {
  const text = str(value);
  if (text === null || text.length > 64) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function emailOrNull(value: unknown): string | null {
  const text = str(value);
  if (text === null) return null;
  const normalized = normalizeContactEmail(text);
  return normalized.ok ? normalized.value : null;
}

function refOf(metadata: unknown): string | null {
  if (!isRecord(metadata)) return null;
  const value = str(metadata.fusion_message_id);
  return value !== null && UUID.test(value) ? value : null;
}

/** TOUTES les valeurs d'un en-tête (un même nom peut apparaître plusieurs fois : celui du fournisseur et celui, éventuellement forgé, de l'expéditeur). */
function headerValues(headers: unknown, name: string): string[] {
  if (!Array.isArray(headers)) return [];
  const found: string[] = [];
  for (const header of headers) {
    if (isRecord(header) && typeof header.Name === "string" && header.Name.toLowerCase() === name && typeof header.Value === "string") found.push(header.Value);
  }
  return found;
}

const headerValue = (headers: unknown, name: string): string | null => headerValues(headers, name)[0] ?? null;

const domainOf = (address: string): string => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/** Même domaine, ou l'un est un sous-domaine de l'autre (frontière de point) : alignement « relâché ». */
function domainsAligned(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * L'expéditeur est-il authentifié POUR L'ADRESSE QU'IL AFFICHE ? Le « Pass » SPF ne vaut que pour le domaine de l'enveloppe : il faut que ce domaine
 * soit celui de l'adresse « From » (sinon un attaquant passe SPF avec son propre domaine et affiche l'adresse d'un contact). Les en-têtes sont posés
 * par le fournisseur MAIS un en-tête de même nom peut aussi venir de l'expéditeur : plusieurs occurrences = non fiable (refus, la file des cas
 * ambigus décide). Deux preuves acceptées : SPF « Pass » aligné, ou DKIM valide du domaine de l'auteur (`DKIM_VALID_AU`, SpamAssassin).
 */
function senderAuthenticated(headers: unknown, from: string): boolean {
  const fromDomain = domainOf(from);
  const spf = headerValues(headers, "received-spf");
  if (spf.length === 1) {
    const value = (spf[0] ?? "").trim();
    if (value.toLowerCase().startsWith("pass")) {
      const envelope = /(?:envelope-from|smtp\.mailfrom)=([^;\s]+)/i.exec(value)?.[1]?.replace(/^<|>$/g, "");
      if (envelope && envelope.includes("@") && domainsAligned(domainOf(envelope), fromDomain)) return true;
    }
  }
  const tests = headerValues(headers, "x-spam-tests");
  return tests.length === 1 && (tests[0] ?? "").split(",").map((t) => t.trim()).includes("DKIM_VALID_AU");
}

/**
 * Adresses destinataires qui désignent le canal. `OriginalRecipient` (l'adresse réellement atteinte, posée par le fournisseur) est la seule utilisée
 * quand elle existe ; l'en-tête « To », que l'expéditeur écrit comme il veut, ne sert qu'à défaut (sinon un expéditeur choisirait le canal). La base
 * cherche l'adresse exacte, puis sans l'étiquette `+xxx`.
 */
function inboundRecipients(raw: Record<string, unknown>): string[] {
  const original = emailOrNull(raw.OriginalRecipient);
  if (original !== null) return [original];
  const found = new Set<string>();
  if (Array.isArray(raw.ToFull)) {
    for (const entry of raw.ToFull) {
      const email = isRecord(entry) ? emailOrNull(entry.Email) : null;
      if (email !== null) found.add(email);
    }
  }
  return [...found].slice(0, RECIPIENTS_MAX);
}

/** Lit un payload Postmark ; `null` si ce n'est pas un événement exploitable (forme invalide, identifiant absent). */
export function normalizePostmarkPayload(raw: unknown): EmailEvent | null {
  if (!isRecord(raw)) return null;
  const recordType = str(raw.RecordType);

  if (recordType === "Delivery") {
    const providerMessageId = str(raw.MessageID);
    const recipient = emailOrNull(raw.Recipient);
    const deliveredAt = str(raw.DeliveredAt);
    if (providerMessageId === null || !PROVIDER_ID.test(providerMessageId) || recipient === null || deliveredAt === null) return null;
    // clé composée (identifiant, destinataire, date) : un même message peut être remis à plusieurs destinataires
    return { kind: "delivered", eventId: eventKey("delivery", `${providerMessageId}:${short(`${recipient}|${deliveredAt}`)}`), providerMessageId, recipient, at: isoOrNull(deliveredAt), ref: refOf(raw.Metadata) };
  }

  if (recordType === "Bounce" || recordType === "SpamComplaint") {
    const providerMessageId = str(raw.MessageID);
    const recipient = emailOrNull(raw.Email);
    const id = typeof raw.ID === "number" && Number.isSafeInteger(raw.ID) && raw.ID > 0 ? raw.ID : null;
    if (providerMessageId === null || !PROVIDER_ID.test(providerMessageId) || recipient === null || id === null) return null;
    const at = isoOrNull(raw.BouncedAt);
    const ref = refOf(raw.Metadata);
    if (recordType === "SpamComplaint") return { kind: "complaint", eventId: `complaint:${id}`, providerMessageId, recipient, at, ref };
    return { kind: "bounced", eventId: `bounce:${id}`, hard: raw.TypeCode === 1 || raw.TypeCode === 100000, providerMessageId, recipient, at, ref };
  }

  if (recordType === null && isRecord(raw.FromFull) && typeof raw.MessageID === "string") {
    const providerMessageId = raw.MessageID;
    const from = emailOrNull(raw.FromFull.Email);
    if (!PROVIDER_ID.test(providerMessageId) || from === null) return null;
    const recipients = inboundRecipients(raw);
    const text = cleanText(str(raw.TextBody) ?? "", EMAIL_BODY_MAX).trim();
    const stripped = cleanText(str(raw.StrippedTextReply) ?? "", EMAIL_BODY_MAX).trim();
    const body = text.length > 0 ? text : stripped.length > 0 ? stripped : "(message sans texte)";
    const subject = cleanText(str(raw.Subject) ?? "", SUBJECT_MAX).trim();
    return {
      kind: "inbound",
      eventId: eventKey("inbound", providerMessageId),
      providerMessageId,
      from,
      recipients,
      subject: subject.length > 0 ? subject : null,
      body,
      at: isoOrNull(headerValue(raw.Headers, "date") ?? raw.Date),
      spfPass: senderAuthenticated(raw.Headers, from),
      spam: headerValues(raw.Headers, "x-spam-status").some((value) => value.trim().toLowerCase().startsWith("yes")),
    };
  }

  // autre type d'événement (ouverture, clic, changement d'abonnement...) : acquitté, jamais traité
  if (recordType !== null && /^[A-Za-z]{1,40}$/.test(recordType)) return { kind: "ignored", eventId: `ignored:${recordType}`, recordType };
  return null;
}

/** Relit un événement CONSERVÉ (forme normalisée) ; `null` si la forme n'est pas celle qu'on a écrite. */
export function readEmailEvent(value: unknown): EmailEvent | null {
  if (!isRecord(value)) return null;
  const kind = str(value.kind);
  const eventId = str(value.eventId);
  if (kind === null || eventId === null || !EVENT_ID.test(eventId)) return null;
  const optionalIso = (v: unknown): string | null | undefined => (v === null ? null : typeof v === "string" && isoOrNull(v) !== null ? v : undefined);
  const optionalRef = (v: unknown): string | null | undefined => (v === null ? null : typeof v === "string" && UUID.test(v) ? v : undefined);

  if (kind === "ignored") {
    const recordType = str(value.recordType);
    return recordType !== null && /^[A-Za-z]{1,40}$/.test(recordType) ? { kind, eventId, recordType } : null;
  }
  if (kind === "delivered" || kind === "bounced" || kind === "complaint") {
    const providerMessageId = str(value.providerMessageId);
    const recipient = str(value.recipient);
    const at = optionalIso(value.at);
    const ref = optionalRef(value.ref);
    if (providerMessageId === null || !PROVIDER_ID.test(providerMessageId) || recipient === null || at === undefined || ref === undefined) return null;
    if (!normalizeContactEmail(recipient).ok) return null;
    if (kind === "bounced") return typeof value.hard === "boolean" ? { kind, eventId, hard: value.hard, providerMessageId, recipient, at, ref } : null;
    return { kind, eventId, providerMessageId, recipient, at, ref };
  }
  if (kind === "inbound") {
    const providerMessageId = str(value.providerMessageId);
    const from = str(value.from);
    const body = str(value.body);
    const subject = value.subject === null ? null : str(value.subject);
    const at = optionalIso(value.at);
    const recipients = value.recipients;
    if (
      providerMessageId === null || !PROVIDER_ID.test(providerMessageId) || from === null || !normalizeContactEmail(from).ok || body === null ||
      body.length < 1 || body.length > EMAIL_BODY_MAX || (value.subject !== null && subject === null) || (subject !== null && subject.length > SUBJECT_MAX) ||
      at === undefined || typeof value.spfPass !== "boolean" || typeof value.spam !== "boolean" ||
      !Array.isArray(recipients) || recipients.length < 1 || recipients.length > RECIPIENTS_MAX || !recipients.every((r) => typeof r === "string" && normalizeContactEmail(r).ok)
    ) {
      return null;
    }
    return { kind, eventId, providerMessageId, from, recipients: recipients as string[], subject, body, at, spfPass: value.spfPass, spam: value.spam };
  }
  return null;
}
