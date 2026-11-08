import { z } from "zod";

/**
 * Textes saisis par les utilisateurs (projets et produits, J16). Miroir (légèrement plus strict) de
 * `private.is_safe_text` et `private.is_safe_https_url` côté base : la base reste l'autorité, ce contrôle donne
 * des messages de champ avant l'appel. Écrit sans expression régulière sur les caractères de contrôle (règle ESLint
 * `no-control-regex`).
 */

/**
 * Caractères invisibles ou de direction : trait d'union conditionnel, joint de graphèmes, marque de lettre arabe, remplisseurs
 * Hangul, séparateur mongol, espaces de largeur nulle et marques de direction, séparateurs de ligne et de paragraphe, joints
 * et opérateurs invisibles, sélecteurs de variation, BOM, caractères d'annotation et de balise. Miroir de `private.is_safe_text`.
 */
function isInvisibleOrDirectional(cp: number): boolean {
  return (
    cp === 0x00ad ||
    cp === 0x034f ||
    cp === 0x061c ||
    cp === 0x115f ||
    cp === 0x180e ||
    (cp >= 0x200b && cp <= 0x200f) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    cp === 0x3164 ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0xfeff ||
    (cp >= 0xfff9 && cp <= 0xfffc) ||
    (cp >= 0xe0000 && cp <= 0xe007f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

/**
 * Texte sûr : longueur (en caractères) bornée, sans espace en bordure, sans caractère de contrôle (hors tabulation
 * et saut de ligne si `multiline`), de direction, séparateur de ligne, BOM ni caractère de balise.
 */
export function isSafeText(value: string, min: number, max: number, multiline = false): boolean {
  const chars = [...value];
  if (chars.length < min || chars.length > max) return false;
  if (value !== value.trim()) return false;
  for (const char of chars) {
    const cp = char.codePointAt(0) ?? 0;
    const isControl = cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);
    if (isControl && !(multiline && (cp === 0x09 || cp === 0x0a || cp === 0x0d))) return false;
    if (isInvisibleOrDirectional(cp)) return false;
  }
  return true;
}

/** Texte rogné puis vérifié ; le message d'erreur est un code, jamais la valeur. */
export const safeText = (min: number, max: number, multiline = false) =>
  z
    .string()
    .transform((value) => value.trim())
    .refine((value) => isSafeText(value, min, max, multiline), { message: "invalid_text" });

/**
 * Même forme que `private.is_safe_https_url` : https, NOM DE DOMAINE seulement (étiquettes et extension alphabétique : ni adresse IP,
 * ni « localhost », ni identifiants intégrés), port de 1 à 65535, chemin sans espace ni caractère dangereux, jamais de caractère
 * invisible ou de direction, 2048 caractères au plus, aucun nom réservé aux réseaux internes. Prérequis du futur chargement serveur
 * des liens (anti-SSRF) : la validation d'adresse reste à refaire au moment du chargement (résolution DNS).
 */
const PORT = "[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]";
// String.raw : les barres obliques inverses restent telles quelles pour l'expression régulière (\x60 = apostrophe inversée).
const HTTPS_URL_SHAPE = new RegExp(
  String.raw`^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(:(${PORT}))?(/[^\s<>"\\^\x60{|}]*)?$`,
  "i",
);
const INTERNAL_HOST = /^https:\/\/[^/:?#]*\.(local|localhost|internal|lan|intranet|corp|home|test\.local)(:|\/|\?|#|$)/i;
export const HTTPS_URL_MAX_LENGTH = 2048;

export function isSafeHttpsUrl(value: string): boolean {
  if (value.length > HTTPS_URL_MAX_LENGTH || !HTTPS_URL_SHAPE.test(value) || INTERNAL_HOST.test(value)) return false;
  for (const char of value) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || isInvisibleOrDirectional(cp)) return false;
  }
  return true;
}

export const httpsUrlSchema = z
  .string()
  .transform((value) => value.trim())
  .refine(isSafeHttpsUrl, { message: "invalid_url" });
