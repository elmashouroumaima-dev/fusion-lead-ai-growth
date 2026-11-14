import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { KeyRing } from "../secrets/crypto";

/**
 * Lien de désabonnement signé (J33, spec §9.2, ADR 008). Le jeton ne contient AUCUNE donnée personnelle : seulement l'entreprise et le message
 * (deux UUID) et une signature HMAC-SHA256. L'entreprise et le contact sont donc retrouvés côté serveur à partir de la ligne du message, jamais
 * d'un champ envoyé par le navigateur.
 *
 * Clé : dérivée (HKDF-SHA256, étiquette dédiée) de la clé maître du trousseau (ADR 004) : une clé distincte du chiffrement des secrets, sans
 * nouvelle variable d'environnement. Le jeton porte la version de clé : après une rotation, les anciens liens (déjà dans des boîtes de réception)
 * restent valides tant que l'ancienne version est dans le trousseau.
 * Format : `v1.<version de clé>.<entreprise>.<message>.<signature base64url>`. Pas d'expiration : un lien de désabonnement doit rester utilisable,
 * et son seul effet est de retirer le consentement.
 */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TOKEN = new RegExp(`^v1\\.([1-9][0-9]{0,3})\\.(${UUID})\\.(${UUID})\\.([A-Za-z0-9_-]{43})$`);
const INFO = "fusion-leap/unsubscribe/v1";

export type UnsubscribeClaims = { organizationId: string; messageId: string };

function deriveKey(masterKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), INFO, 32));
}

function sign(key: Buffer, version: number, claims: UnsubscribeClaims): string {
  return createHmac("sha256", key).update(`v1.${version}.${claims.organizationId}.${claims.messageId}`).digest("base64url");
}

export function createUnsubscribeToken(keyRing: KeyRing, claims: UnsubscribeClaims): string {
  const master = keyRing.keys.get(keyRing.current);
  if (!master) throw new Error("unsubscribe_key_unavailable");
  const key = deriveKey(master);
  return `v1.${keyRing.current}.${claims.organizationId}.${claims.messageId}.${sign(key, keyRing.current, claims)}`;
}

/** Renvoie les revendications si (et seulement si) la signature est valide ; `null` sinon (format, version inconnue, signature fausse). */
export function verifyUnsubscribeToken(keyRing: KeyRing, token: string): UnsubscribeClaims | null {
  if (token.length > 200) return null;
  const match = TOKEN.exec(token);
  if (!match) return null;
  const version = Number(match[1]);
  const master = keyRing.keys.get(version);
  if (!master) return null;
  const claims = { organizationId: match[2] as string, messageId: match[3] as string };
  const expected = Buffer.from(sign(deriveKey(master), version, claims));
  const given = Buffer.from(match[4] as string);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return claims;
}

/** Lien public du désabonnement : `{SITE_URL}/api/unsubscribe/{jeton}` (GET : page de confirmation ; POST : un clic). Le site est celui de l'application, jamais une valeur du client. */
export function unsubscribeUrl(siteUrl: string, token: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/api/unsubscribe/${token}`;
}

/** En-têtes de l'e-mail : désabonnement en un clic (RFC 8058) et lien (RFC 2369). */
export function listUnsubscribeHeaders(url: string): { name: string; value: string }[] {
  return [
    { name: "List-Unsubscribe", value: `<${url}>` },
    { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
  ];
}

/** Pied de page texte : le destinataire voit toujours comment se désabonner (identité de l'expéditeur déjà dans `From`). */
export function appendUnsubscribeFooter(textBody: string, url: string): string {
  return `${textBody}\n\n--\nSe désabonner : ${url}`;
}
