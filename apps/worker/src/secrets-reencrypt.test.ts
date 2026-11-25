import { randomBytes } from "node:crypto";
import { createKeyRing, decryptSecret, encryptSecret, fingerprintSecret, organizationSecretAad, platformSecretAad } from "@fusion-leap/adapters";
import { describe, expect, it, vi } from "vitest";
import { reencryptSecrets, startSecretsReencrypt, type SealedSecret, type SecretRow, type SecretsReencryptGateway } from "./secrets-reencrypt";

const key = () => randomBytes(32).toString("base64");
const K1 = key();
const K2 = key();
const oldRing = createKeyRing(1, { 1: K1 });
const ring = createKeyRing(2, { 1: K1, 2: K2 });
const ORG = "11111111-1111-4111-8111-111111111111";
const ID = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;

type Stored = SecretRow & { fingerprint: string | null };

function memory(rows: Stored[], hook?: (row: Stored) => void) {
  const writes: Array<{ id: string; fingerprint: string | null }> = [];
  const gateway: SecretsReencryptGateway = {
    async due(currentVersion, limit) {
      return rows.filter((r) => r.keyVersion !== currentVersion || (r.fingerprint === null && r.purpose.startsWith("integration"))).slice(0, limit).map((r) => ({ ...r }));
    },
    async write(row, sealed: SealedSecret, fingerprint) {
      const current = rows.find((r) => r.id === row.id);
      if (current) hook?.(current);
      // même règle que la base : l'écriture n'a lieu que si la ligne n'a pas changé depuis la lecture
      if (!current || current.keyVersion !== row.keyVersion || current.ciphertext !== row.ciphertext) return false;
      Object.assign(current, sealed, { fingerprint });
      writes.push({ id: row.id, fingerprint });
      return true;
    },
  };
  return { gateway, writes };
}

const seal = (id: string, purpose: string, plaintext: string, org: string | null = ORG, withRing = oldRing): Stored => {
  const aad = purpose === "smtp" ? platformSecretAad("smtp", id) : organizationSecretAad(org as string, id);
  const e = encryptSecret({ plaintext, keyRing: withRing, aad });
  return { id, purpose, organizationId: org, ciphertext: e.ciphertext, nonce: e.nonce, keyVersion: e.keyVersion, fingerprint: null };
};
const open = (row: Stored) =>
  decryptSecret({
    secret: { ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.keyVersion },
    keyRing: ring,
    aad: row.purpose === "smtp" ? platformSecretAad("smtp", row.id) : organizationSecretAad(row.organizationId as string, row.id),
  });

describe("reencryptSecrets (S-11)", () => {
  it("rechiffre avec la clé courante : même texte clair, version 2, nouveau nonce, empreinte recalculée pour jeton et secret de webhook, aucune pour SMTP", async () => {
    const rows = [seal(ID(1), "integration", "jeton-a"), seal(ID(2), "integration_webhook", "whsec-b"), seal(ID(3), "smtp", "mot-de-passe", null)];
    const nonces = rows.map((r) => r.nonce);
    const { gateway } = memory(rows);
    const result = await reencryptSecrets(gateway, ring);
    expect(result).toEqual({ rewritten: 3, changed: 0, failures: 0 });
    expect(rows.map((r) => r.keyVersion)).toEqual([2, 2, 2]);
    expect(rows.map(open)).toEqual(["jeton-a", "whsec-b", "mot-de-passe"]);
    expect(rows.map((r) => r.nonce)).not.toEqual(nonces);
    expect(rows[0]?.fingerprint).toBe(fingerprintSecret({ plaintext: "jeton-a", keyRing: ring }));
    expect(rows[1]?.fingerprint).toBe(fingerprintSecret({ plaintext: "whsec-b", keyRing: ring }));
    expect(rows[2]?.fingerprint).toBeNull();
  });

  it("rien à faire : aucune écriture, et un second passage ne refait rien", async () => {
    const rows = [seal(ID(1), "integration", "jeton", ORG, ring)];
    (rows[0] as Stored).fingerprint = fingerprintSecret({ plaintext: "jeton", keyRing: ring });
    const { gateway, writes } = memory(rows);
    expect(await reencryptSecrets(gateway, ring)).toEqual({ rewritten: 0, changed: 0, failures: 0 });
    expect(writes).toHaveLength(0);
  });

  it("rattrape un jeton déjà à la version courante mais sans empreinte (secret d'avant S-12)", async () => {
    const rows = [seal(ID(1), "integration", "jeton", ORG, ring)];
    const { gateway } = memory(rows);
    expect(await reencryptSecrets(gateway, ring)).toEqual({ rewritten: 1, changed: 0, failures: 0 });
    expect(rows[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await reencryptSecrets(gateway, ring)).toEqual({ rewritten: 0, changed: 0, failures: 0 });
  });

  it("une rotation de jeton faite pendant le job n'est PAS écrasée (écriture refusée, comptée « changed »)", async () => {
    const rows = [seal(ID(1), "integration", "ancien-jeton")];
    const fresh = seal(ID(1), "integration", "nouveau-jeton", ORG, ring);
    const { gateway } = memory(rows, (current) => Object.assign(current, { ciphertext: fresh.ciphertext, nonce: fresh.nonce, keyVersion: 2 }));
    const result = await reencryptSecrets(gateway, ring);
    expect(result.changed).toBe(1);
    // le nouveau jeton (déjà à la version courante, sans empreinte) est repris au lot suivant : rechiffré tel quel, jamais remplacé par l'ancien
    expect(open(rows[0] as Stored)).toBe("nouveau-jeton");
  });

  it("un secret illisible (version de clé inconnue, usage inconnu) est compté en échec sans bloquer les autres", async () => {
    const lost = createKeyRing(9, { 9: key() });
    const rows = [seal(ID(1), "integration", "perdu", ORG, lost), seal(ID(2), "autre_usage", "x"), seal(ID(3), "integration", "bon")];
    const { gateway } = memory(rows);
    const result = await reencryptSecrets(gateway, ring);
    expect(result).toEqual({ rewritten: 1, changed: 0, failures: 2 });
    expect(open(rows[2] as Stored)).toBe("bon");
  });

  it("une lecture en échec ne lève pas ; une ligne qui échoue est comptée une fois et le passage s'arrête (pas de boucle)", async () => {
    const broken: SecretsReencryptGateway = { due: async () => Promise.reject(new Error("réseau")), write: async () => true };
    expect(await reencryptSecrets(broken, ring)).toEqual({ rewritten: 0, changed: 0, failures: 1 });
    const due = vi.fn(async () => [seal(ID(1), "autre_usage", "x")]);
    const stuck: SecretsReencryptGateway = { due, write: async () => true };
    expect((await reencryptSecrets(stuck, ring)).failures).toBe(1);
    expect(due).toHaveBeenCalledTimes(2);
  });
});

describe("startSecretsReencrypt (S-11)", () => {
  it("journalise des nombres seulement (aucun identifiant ni secret)", async () => {
    const rows = [seal(ID(1), "integration", "jeton-secret-a-ne-pas-journaliser")];
    const { gateway } = memory(rows);
    const info = vi.fn();
    const stop = startSecretsReencrypt(gateway, ring, { info, warn: vi.fn(), error: vi.fn() }, 3_600_000);
    await vi.waitFor(() => expect(info).toHaveBeenCalled());
    stop();
    const [event, fields] = info.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(event).toBe("secrets_reencrypt");
    expect(fields).toEqual({ rewritten: 1, changed: 0, failures: 0, key_version: 2 });
    expect(JSON.stringify(info.mock.calls)).not.toContain("jeton-secret");
  });
});
