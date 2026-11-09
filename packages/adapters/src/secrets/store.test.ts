import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SecretCryptoError, createKeyRing } from "./crypto";
import { createMemorySecretGateway, createSecretStore, openOrganizationSecret, sealOrganizationSecret } from "./store";

const key = () => randomBytes(32).toString("base64");
const ring = (version = 1, k = key()) => createKeyRing(version, { [version]: k });
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INTEGRATION = "11111111-1111-4111-8111-111111111111";
const TOKEN = "EAAB-jeton-de-test-0123456789";

describe("sealOrganizationSecret / openOrganizationSecret", () => {
  it("aller-retour : le jeton revient à l'identique, le chiffré ne le contient pas", () => {
    const keyRing = ring();
    const stored = sealOrganizationSecret({ organizationId: ORG_A, plaintext: TOKEN, keyRing });
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
    expect(openOrganizationSecret({ organizationId: ORG_A, stored, keyRing })).toBe(TOKEN);
  });

  it("deux chiffrements du même jeton diffèrent (nonce et identifiant neufs)", () => {
    const keyRing = ring();
    const first = sealOrganizationSecret({ organizationId: ORG_A, plaintext: TOKEN, keyRing });
    const second = sealOrganizationSecret({ organizationId: ORG_A, plaintext: TOKEN, keyRing });
    expect(first.secretId).not.toBe(second.secretId);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("rejeu inter-entreprises refusé : le secret d'Alpha ne s'ouvre pas avec l'identité de Beta", () => {
    const keyRing = ring();
    const stored = sealOrganizationSecret({ organizationId: ORG_A, plaintext: TOKEN, keyRing });
    expect(() => openOrganizationSecret({ organizationId: ORG_B, stored, keyRing })).toThrow(SecretCryptoError);
  });

  it("rejeu sous un autre identifiant de secret refusé", () => {
    const keyRing = ring();
    const stored = sealOrganizationSecret({ organizationId: ORG_A, plaintext: TOKEN, keyRing });
    expect(() => openOrganizationSecret({ organizationId: ORG_A, stored: { ...stored, secretId: "22222222-2222-4222-8222-222222222222" }, keyRing })).toThrow(SecretCryptoError);
  });

  it("une autre clé maître ou une version inconnue ne déchiffre pas ; l'erreur ne dit rien", () => {
    const stored = sealOrganizationSecret({ organizationId: ORG_A, plaintext: TOKEN, keyRing: ring(1) });
    for (const other of [ring(1), ring(2)]) {
      try {
        openOrganizationSecret({ organizationId: ORG_A, stored, keyRing: other });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(SecretCryptoError);
        expect(String((error as Error).message)).not.toContain(TOKEN);
      }
    }
  });
});

describe("createSecretStore : put, get, rotate, delete", () => {
  it("put puis get rendent le jeton ; rien n'est stocké en clair", async () => {
    const gateway = createMemorySecretGateway();
    const store = createSecretStore(gateway, ring());
    await store.put(ORG_A, INTEGRATION, TOKEN);
    expect(await store.get(ORG_A, INTEGRATION)).toBe(TOKEN);
    expect(JSON.stringify(await gateway.get(ORG_A, INTEGRATION))).not.toContain(TOKEN);
  });

  it("rotate remplace le jeton : l'ancien n'est plus lisible, l'identifiant du secret change", async () => {
    const gateway = createMemorySecretGateway();
    const store = createSecretStore(gateway, ring());
    await store.put(ORG_A, INTEGRATION, TOKEN);
    const before = (await gateway.get(ORG_A, INTEGRATION))?.secretId;
    await store.rotate(ORG_A, INTEGRATION, "nouveau-jeton");
    expect(await store.get(ORG_A, INTEGRATION)).toBe("nouveau-jeton");
    expect((await gateway.get(ORG_A, INTEGRATION))?.secretId).not.toBe(before);
    expect(gateway.snapshot()).toHaveLength(1);
  });

  it("delete supprime le secret ; get renvoie null", async () => {
    const store = createSecretStore(createMemorySecretGateway(), ring());
    await store.put(ORG_A, INTEGRATION, TOKEN);
    await store.delete(ORG_A, INTEGRATION);
    expect(await store.get(ORG_A, INTEGRATION)).toBeNull();
  });

  it("une intégration d'une autre entreprise est introuvable (null), jamais le secret d'Alpha", async () => {
    const store = createSecretStore(createMemorySecretGateway(), ring());
    await store.put(ORG_A, INTEGRATION, TOKEN);
    expect(await store.get(ORG_B, INTEGRATION)).toBeNull();
  });

  it("rotation de la clé maître : un secret chiffré avec l'ancienne version reste lisible tant que le trousseau la contient", async () => {
    const oldKey = key();
    const newKey = key();
    const gateway = createMemorySecretGateway();
    await createSecretStore(gateway, createKeyRing(1, { 1: oldKey })).put(ORG_A, INTEGRATION, TOKEN);
    const both = createKeyRing(2, { 1: oldKey, 2: newKey });
    const store = createSecretStore(gateway, both);
    expect(await store.get(ORG_A, INTEGRATION)).toBe(TOKEN);
    await store.rotate(ORG_A, INTEGRATION, TOKEN);
    expect((await gateway.get(ORG_A, INTEGRATION))?.keyVersion).toBe(2);
  });
});
