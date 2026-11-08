import { createHash, createHmac } from "node:crypto";
import { isIP } from "node:net";
import { buildConsentProof, type CapturePayload } from "@fusion-leap/domain";
import { getServerEnv } from "../env/server";
import { createAdminClient, deriveServerSecret } from "../supabase/admin";
import { ServiceError, type ServiceErrorCode } from "./errors";

/**
 * Capture publique de leads (J21, spec §9.1). SEUL usage métier du client service_role (décision de la responsable technique à
 * valider : la route publique n'a ni session ni entreprise, la CLÉ DE FORMULAIRE en tient lieu) : un appel à `capture_lead`,
 * fonction SQL réservée à service_role qui retrouve l'entreprise et le projet par l'empreinte de la clé, vérifie l'origine,
 * puis écrit contact, lead, consentement et job d'assignation dans UNE transaction. L'entreprise ne vient jamais du corps de la
 * requête. Fichier sous `lib/service/**` (confinement de service_role, J11).
 *
 * Aucune donnée personnelle dans les journaux ni dans les erreurs : seuls des codes sortent d'ici.
 */

/** Empreinte SHA-256 d'une clé de formulaire (la base ne conserve que l'empreinte). */
export const hashFormKey = (key: string): string => createHash("sha256").update(key, "utf8").digest("hex");

/**
 * Identifiant opaque d'une adresse IP pour les seaux de limitation de débit : HMAC-SHA-256 (clé = secret serveur DÉRIVÉ), tronqué à 32
 * caractères. La base ne reçoit jamais l'adresse en clair ; sans le secret, l'empreinte n'est pas retrouvable par force brute.
 */
export function ipBucketKey(ip: string): string {
  return createHmac("sha256", deriveServerSecret("capture-ip-bucket")).update(`capture-ip:${ipBucketPrefix(ip)}`, "utf8").digest("hex").slice(0, 32);
}

/** Développe une adresse IPv6 en 8 groupes de 4 chiffres hexadécimaux. */
function expandIPv6(ip: string): string[] {
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === "" ? [] : tail.split(":");
  const middle = ip.includes("::") ? Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0") : [];
  return [...left, ...middle, ...right].map((group) => group.padStart(4, "0"));
}

/**
 * Valeur de regroupement d'une adresse pour la limitation de débit : IPv4 telle quelle ; IPv6 par préfixe /64 (un abonné reçoit un
 * /64 entier : sans cela, il changerait d'adresse à volonté pour contourner la limite).
 */
export function ipBucketPrefix(ip: string): string {
  return isIP(ip) === 6 ? expandIPv6(ip).slice(0, 4).join(":") : ip;
}

/** Retire le port (`1.2.3.4:5678`, `[2001:db8::1]:443`) puis valide l'adresse ; valeur illisible : `null`. */
function parseIp(raw: string): string | null {
  const value = raw.trim();
  const bracket = /^\[([0-9a-fA-F:.]+)\](?::\d{1,5})?$/.exec(value);
  const withoutPort = bracket?.[1] ?? (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(value) ? value.slice(0, value.lastIndexOf(":")) : value);
  return isIP(withoutPort) !== 0 ? withoutPort : null;
}

/**
 * Adresse du visiteur (ADR 010) : l'élément de `x-forwarded-for` situé à `hops` rangs en partant de la DROITE, `hops` étant le
 * nombre de reverse proxys de confiance (`TRUSTED_PROXY_HOPS`, 1 par défaut) : chaque proxy AJOUTE l'adresse qu'il voit, donc les
 * éléments à gauche sont ceux du client et ne sont jamais crus. `hops` = 0, en-tête absent, trop court ou illisible : `null`.
 */
export function clientIp(headers: Pick<Headers, "get">, hops: number = getServerEnv().TRUSTED_PROXY_HOPS): string | null {
  if (!Number.isInteger(hops) || hops < 1) return null;
  const items = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  const raw = items[items.length - hops];
  return raw === undefined ? null : parseIp(raw);
}

/** Erreur SQL -> code d'API. Clé inconnue / inactive, origine refusée, projet archivé : le même refus (aucun oracle). */
function mapCaptureError(error: { code?: string | null; message?: string | null }): ServiceErrorCode {
  const code = error.code ?? "";
  const message = error.message ?? "";
  if (code === "P0001") {
    if (message.includes("form_key_invalid")) return "forbidden";
    if (message.includes("quota_exceeded") || message.includes("subscription_inactive")) return "quota_exceeded";
    if (message.includes("too_many_leads") || message.includes("pipeline_incomplete")) return "conflict";
  }
  if (code === "22023" || code === "23514") return "validation_failed";
  return "internal_error";
}

/** Origine d'un navigateur autorisée par au moins une clé active d'un projet actif (préflight CORS). */
export async function isOriginAllowed(origin: string): Promise<boolean> {
  try {
    const { data, error } = await createAdminClient().rpc("form_origin_allowed", { p_origin: origin });
    return !error && data === true;
  } catch {
    return false;
  }
}

/** Clé active d'un projet actif ET origine de CETTE clé (aucune écriture) ; toute erreur : faux (échec fermé). */
export async function isFormKeyOriginOk(keyHash: string, origin: string): Promise<boolean> {
  try {
    const { data, error } = await createAdminClient().rpc("form_key_origin_ok", { p_key_hash: keyHash, p_origin: origin });
    return !error && data === true;
  } catch {
    return false;
  }
}

export type CaptureResult = { contactCreated: boolean; leadCreated: boolean; consentRecorded: boolean };

/** Écrit la soumission. Lève `ServiceError` : forbidden (clé / origine), quota_exceeded, validation_failed, conflict, internal_error. */
export async function captureLead(input: { keyHash: string; origin: string; ip: string | null; payload: CapturePayload }): Promise<CaptureResult> {
  const { payload } = input;
  let data: unknown;
  try {
    const result = await createAdminClient().rpc("capture_lead", {
      p_key_hash: input.keyHash,
      p_origin: input.origin,
      p_name: payload.name,
      p_email_raw: payload.email_raw,
      p_email_normalized: payload.email_normalized,
      p_phone_e164: payload.phone_e164,
      p_language: payload.language,
      p_country: payload.country,
      p_utm: payload.utm,
      p_consent: payload.consent
        ? { channel: payload.consent.channel, purpose: payload.consent.purpose, proof: buildConsentProof(payload.consent, input.ip) }
        : null,
    });
    if (result.error) throw new ServiceError(mapCaptureError(result.error));
    data = result.data;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError("internal_error");
  }
  if (typeof data !== "object" || data === null) throw new ServiceError("internal_error");
  const row = data as Record<string, unknown>;
  return { contactCreated: row.contact_created === true, leadCreated: row.lead_created === true, consentRecorded: row.consent_recorded === true };
}
