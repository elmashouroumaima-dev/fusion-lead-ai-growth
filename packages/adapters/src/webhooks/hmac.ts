import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Vérification d'une signature HMAC-SHA256 hexadécimale (par exemple `X-Hub-Signature-256: sha256=<hex>` de WhatsApp), sur le corps BRUT,
 * en temps constant. Renvoie `false` pour toute entrée absente, mal formée ou de mauvaise longueur : jamais d'exception, jamais de
 * détail sur la cause.
 */
export function verifyHmacSha256Hex(input: { secret: string | null; rawBody: Uint8Array; signature: string | undefined; prefix?: string }): boolean {
  const { secret, rawBody, signature, prefix = "" } = input;
  if (!secret || typeof signature !== "string") return false;
  const received = signature.startsWith(prefix) ? signature.slice(prefix.length) : null;
  if (received === null || !/^[0-9a-fA-F]{64}$/.test(received)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(received, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Signature HMAC-SHA256 hexadécimale d'un corps (pour les tests et les adaptateurs qui doivent signer). */
export function signHmacSha256Hex(secret: string, rawBody: Uint8Array): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}
