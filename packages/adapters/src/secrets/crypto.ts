import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Chiffrement applicatif des secrets (ADR 004, option B) : AES-256-GCM, nonce unique de 96 bits par chiffrement,
 * données associées (AAD) qui lient le secret à son usage et à son identifiant (un secret ne se rejoue ni dans une
 * autre ligne ni pour un autre usage). La clé maître vient de l'environnement serveur ; elle n'est jamais en base.
 *
 * Format stocké : `ciphertext` = base64(chiffré || étiquette GCM de 16 octets), `nonce` = base64(12 octets),
 * `keyVersion` = version de la clé maître (rotation).
 */

export type EncryptedSecret = { ciphertext: string; nonce: string; keyVersion: number };

/** Erreur unique : jamais de détail (ni texte clair, ni clé, ni cause) dans le message. */
export class SecretCryptoError extends Error {
  constructor() {
    super("secret_crypto_failed");
    this.name = "SecretCryptoError";
  }
}

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Clé maître depuis sa forme base64 (exactement 32 octets). */
export function parseMasterKey(base64: string): Buffer {
  if (!B64.test(base64)) throw new SecretCryptoError();
  const key = Buffer.from(base64, "base64");
  if (key.length !== KEY_BYTES) throw new SecretCryptoError();
  return key;
}

/** Trousseau de clés par version : la clé courante chiffre, toutes les versions connues déchiffrent. */
export type KeyRing = { current: number; keys: ReadonlyMap<number, Buffer> };

export function createKeyRing(current: number, keys: Record<number, string>): KeyRing {
  const map = new Map<number, Buffer>();
  for (const [version, value] of Object.entries(keys)) map.set(Number(version), parseMasterKey(value));
  if (!map.has(current)) throw new SecretCryptoError();
  return { current, keys: map };
}

/** AAD d'un secret de la plateforme : usage + identifiant de la ligne (`private.secrets.id`). */
export const platformSecretAad = (purpose: string, secretId: string): string => `platform:${purpose}:${secretId}`;
/** AAD d'un secret d'organisation (ADR 004) : `organization_id || secret_id`. */
export const organizationSecretAad = (organizationId: string, secretId: string): string => `org:${organizationId}:${secretId}`;

export function encryptSecret(input: { plaintext: string; keyRing: KeyRing; aad: string }): EncryptedSecret {
  try {
    const key = input.keyRing.keys.get(input.keyRing.current);
    if (!key) throw new SecretCryptoError();
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(input.aad, "utf8"));
    const encrypted = Buffer.concat([cipher.update(input.plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: Buffer.concat([encrypted, tag]).toString("base64"),
      nonce: nonce.toString("base64"),
      keyVersion: input.keyRing.current,
    };
  } catch {
    throw new SecretCryptoError();
  }
}

export function decryptSecret(input: { secret: EncryptedSecret; keyRing: KeyRing; aad: string }): string {
  try {
    const key = input.keyRing.keys.get(input.secret.keyVersion);
    if (!key || !B64.test(input.secret.ciphertext) || !B64.test(input.secret.nonce)) throw new SecretCryptoError();
    const raw = Buffer.from(input.secret.ciphertext, "base64");
    const nonce = Buffer.from(input.secret.nonce, "base64");
    if (nonce.length !== NONCE_BYTES || raw.length < TAG_BYTES) throw new SecretCryptoError();
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(input.aad, "utf8"));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(0, raw.length - TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretCryptoError();
  }
}
