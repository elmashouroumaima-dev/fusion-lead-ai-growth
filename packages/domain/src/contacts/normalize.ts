import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

/**
 * Normalisation des identifiants d'un contact (J18, spec §7 et §13-3, ADR 007). Fonctions PURES : la base re-contrôle la
 * forme (index uniques partiels sur `email_normalized` et `phone_e164`).
 */

export const CONTACT_EMAIL_MAX_LENGTH = 254;
const EMAIL_LOCAL_MAX = 64;

/** Local ASCII (caractères usuels de la RFC 5322) + domaine à étiquettes ; les domaines internationaux s'écrivent en punycode. */
const EMAIL_PATTERN = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export type Normalized = { ok: true; value: string } | { ok: false };

/** Adresse e-mail normalisée : espaces de bordure retirés, minuscules ; `ok: false` si la forme n'est pas acceptable. */
export function normalizeContactEmail(raw: string): Normalized {
  const trimmed = raw.trim();
  // La saisie elle-même doit être de l'ASCII imprimable (le signe Kelvin U+212A, par exemple, devient « k » en minuscules).
  if (!/^[\x20-\x7e]+$/.test(trimmed)) return { ok: false };
  const value = trimmed.toLowerCase();
  if (value.length === 0 || value.length > CONTACT_EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(value)) return { ok: false };
  const local = value.slice(0, value.lastIndexOf("@"));
  if (local.length > EMAIL_LOCAL_MAX || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return { ok: false };
  return { ok: true, value };
}

/**
 * Numéro au format E.164. Un numéro national (« 06 12 34 56 78 », « 050 123 4567 ») exige le pays par défaut (ISO 3166-1
 * alpha-2) ; un numéro international (« +212… » ou « 00212… ») s'interprète seul. `ok: false` si le numéro n'est pas valide.
 */
export function normalizePhone(raw: string, defaultCountry?: string): Normalized {
  const text = raw.trim();
  if (text.length === 0 || text.length > 40) return { ok: false };
  const country = defaultCountry && /^[A-Z]{2}$/.test(defaultCountry) ? (defaultCountry as CountryCode) : undefined;
  const parsed = parsePhoneNumberFromString(text.startsWith("00") ? `+${text.slice(2)}` : text, country);
  if (!parsed || !parsed.isValid()) return { ok: false };
  return { ok: true, value: parsed.number };
}
