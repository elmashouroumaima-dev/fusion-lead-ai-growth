import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SecretCryptoError,
  createKeyRing,
  decryptSecret,
  encryptSecret,
  organizationSecretAad,
  parseMasterKey,
  platformSecretAad,
} from "./crypto";

const key = () => randomBytes(32).toString("base64");
const ID = "11111111-1111-4111-8111-111111111111";
const ring = (version = 1) => createKeyRing(version, { [version]: key() });

describe("parseMasterKey / createKeyRing", () => {
  it("accepte exactement 32 octets en base64", () => {
    expect(parseMasterKey(key())).toHaveLength(32);
  });
  it("refuse une clé trop courte, trop longue ou mal formée", () => {
    for (const bad of [randomBytes(16).toString("base64"), randomBytes(33).toString("base64"), "pas du base64!!", ""]) {
      expect(() => parseMasterKey(bad), bad).toThrow(SecretCryptoError);
    }
  });
  it("le trousseau doit contenir la version courante", () => {
    expect(() => createKeyRing(2, { 1: key() })).toThrow(SecretCryptoError);
  });
});

describe("encryptSecret / decryptSecret", () => {
  const aad = platformSecretAad("smtp", ID);

  it("aller-retour, y compris Unicode et chaîne longue", () => {
    const r = ring();
    for (const plaintext of ["motdepasse", "p@ss wörd ✓ 密码", "x".repeat(5000)]) {
      const secret = encryptSecret({ plaintext, keyRing: r, aad });
      expect(secret.keyVersion).toBe(1);
      expect(secret.ciphertext).not.toContain(plaintext.slice(0, 8));
      expect(decryptSecret({ secret, keyRing: r, aad })).toBe(plaintext);
    }
  });

  it("nonce unique : deux chiffrements du même texte diffèrent", () => {
    const r = ring();
    const a = encryptSecret({ plaintext: "même texte", keyRing: r, aad });
    const b = encryptSecret({ plaintext: "même texte", keyRing: r, aad });
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("AAD : un secret ne se rejoue pas dans une autre ligne, un autre usage ou une autre organisation", () => {
    const r = ring();
    const secret = encryptSecret({ plaintext: "secret", keyRing: r, aad });
    const other = "22222222-2222-4222-8222-222222222222";
    for (const wrong of [platformSecretAad("smtp", other), platformSecretAad("autre", ID), organizationSecretAad(ID, ID)]) {
      expect(() => decryptSecret({ secret, keyRing: r, aad: wrong })).toThrow(SecretCryptoError);
    }
  });

  it("toute altération (chiffré, nonce, étiquette) ou mauvaise clé est refusée", () => {
    const r = ring();
    const secret = encryptSecret({ plaintext: "secret", keyRing: r, aad });
    const flip = (b64: string, i: number) => {
      const buf = Buffer.from(b64, "base64");
      buf[i] = (buf[i] ?? 0) ^ 1;
      return buf.toString("base64");
    };
    expect(() => decryptSecret({ secret: { ...secret, ciphertext: flip(secret.ciphertext, 0) }, keyRing: r, aad })).toThrow(SecretCryptoError);
    const last = Buffer.from(secret.ciphertext, "base64").length - 1;
    expect(() => decryptSecret({ secret: { ...secret, ciphertext: flip(secret.ciphertext, last) }, keyRing: r, aad })).toThrow(SecretCryptoError);
    expect(() => decryptSecret({ secret: { ...secret, nonce: flip(secret.nonce, 0) }, keyRing: r, aad })).toThrow(SecretCryptoError);
    expect(() => decryptSecret({ secret, keyRing: ring(), aad })).toThrow(SecretCryptoError);
    expect(() => decryptSecret({ secret: { ...secret, ciphertext: "court" }, keyRing: r, aad })).toThrow(SecretCryptoError);
    expect(() => decryptSecret({ secret: { ...secret, nonce: "AAAA" }, keyRing: r, aad })).toThrow(SecretCryptoError);
  });

  it("rotation : l'ancienne version se déchiffre encore, la nouvelle chiffre", () => {
    const k1 = key();
    const k2 = key();
    const old = encryptSecret({ plaintext: "ancien", keyRing: createKeyRing(1, { 1: k1 }), aad });
    const rotated = createKeyRing(2, { 1: k1, 2: k2 });
    expect(decryptSecret({ secret: old, keyRing: rotated, aad })).toBe("ancien");
    const fresh = encryptSecret({ plaintext: "nouveau", keyRing: rotated, aad });
    expect(fresh.keyVersion).toBe(2);
    expect(() => decryptSecret({ secret: fresh, keyRing: createKeyRing(1, { 1: k1 }), aad })).toThrow(SecretCryptoError);
  });

  it("l'erreur ne contient ni texte clair ni détail", () => {
    const r = ring();
    const secret = encryptSecret({ plaintext: "très-secret", keyRing: r, aad });
    try {
      decryptSecret({ secret, keyRing: ring(), aad });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toBe("secret_crypto_failed");
      expect(String(error)).not.toContain("très-secret");
    }
  });
});
