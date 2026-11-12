import { randomUUID } from "node:crypto";
import { decryptSecret, encryptSecret, organizationSecretAad, type EncryptedSecret, type KeyRing } from "./crypto";

/**
 * Magasin de secrets d'intégration (ADR 004, J28) : `put`, `get`, `rotate`, `delete` par intégration. Il chiffre et déchiffre
 * (AES-256-GCM, AAD `org:<organization_id>:<secret_id>`) ; l'accès à la base passe par une passerelle (les fonctions SQL
 * `set_integration_secret`, `get_integration_secret` et `disconnect_integration`). Le texte clair n'existe qu'ici, en mémoire, le
 * temps d'un appel : jamais dans un journal, un message d'erreur ou une valeur de retour d'écriture.
 */
export type StoredSecret = EncryptedSecret & { secretId: string };

export interface SecretGateway {
  /** Écrit le nouveau secret chiffré et supprime l'ancien (rotation) dans la même transaction. */
  put(organizationId: string, integrationId: string, sealed: StoredSecret): Promise<void>;
  /** Le chiffré courant de l'intégration, ou `null` (aucun secret, intégration déconnectée ou inconnue de cette entreprise). */
  get(organizationId: string, integrationId: string): Promise<StoredSecret | null>;
  /** Supprime le secret de l'intégration. */
  delete(organizationId: string, integrationId: string): Promise<void>;
}

export interface SecretStore {
  put(organizationId: string, integrationId: string, plaintext: string): Promise<void>;
  /** Remplacer un secret = en écrire un nouveau (la passerelle supprime l'ancien). */
  rotate(organizationId: string, integrationId: string, plaintext: string): Promise<void>;
  get(organizationId: string, integrationId: string): Promise<string | null>;
  delete(organizationId: string, integrationId: string): Promise<void>;
}

/** Chiffre un secret pour une entreprise : identifiant neuf, AAD liée à l'entreprise. */
export function sealOrganizationSecret(input: { organizationId: string; plaintext: string; keyRing: KeyRing; secretId?: string }): StoredSecret {
  const secretId = input.secretId ?? randomUUID();
  const encrypted = encryptSecret({ plaintext: input.plaintext, keyRing: input.keyRing, aad: organizationSecretAad(input.organizationId, secretId) });
  return { ...encrypted, secretId };
}

/** Déchiffre un secret d'une entreprise : échoue (SecretCryptoError) si l'entreprise, l'identifiant ou la clé ne correspondent pas. */
export function openOrganizationSecret(input: { organizationId: string; stored: StoredSecret; keyRing: KeyRing }): string {
  return decryptSecret({
    secret: { ciphertext: input.stored.ciphertext, nonce: input.stored.nonce, keyVersion: input.stored.keyVersion },
    keyRing: input.keyRing,
    aad: organizationSecretAad(input.organizationId, input.stored.secretId),
  });
}

export function createSecretStore(gateway: SecretGateway, keyRing: KeyRing): SecretStore {
  const put = async (organizationId: string, integrationId: string, plaintext: string): Promise<void> => {
    await gateway.put(organizationId, integrationId, sealOrganizationSecret({ organizationId, plaintext, keyRing }));
  };
  return {
    put,
    rotate: put,
    async get(organizationId, integrationId) {
      const stored = await gateway.get(organizationId, integrationId);
      return stored ? openOrganizationSecret({ organizationId, stored, keyRing }) : null;
    },
    delete: (organizationId, integrationId) => gateway.delete(organizationId, integrationId),
  };
}

/** Passerelle en mémoire pour les tests : applique la même règle d'entreprise que la base (un secret appartient à UNE entreprise). */
export function createMemorySecretGateway(): SecretGateway & { snapshot(): Array<{ organizationId: string; integrationId: string; secretId: string }> } {
  const rows = new Map<string, { organizationId: string; integrationId: string; stored: StoredSecret }>();
  const key = (organizationId: string, integrationId: string) => `${organizationId}:${integrationId}`;
  return {
    async put(organizationId, integrationId, sealed) {
      rows.set(key(organizationId, integrationId), { organizationId, integrationId, stored: sealed });
    },
    async get(organizationId, integrationId) {
      return rows.get(key(organizationId, integrationId))?.stored ?? null;
    },
    async delete(organizationId, integrationId) {
      rows.delete(key(organizationId, integrationId));
    },
    snapshot: () => [...rows.values()].map((r) => ({ organizationId: r.organizationId, integrationId: r.integrationId, secretId: r.stored.secretId })),
  };
}
