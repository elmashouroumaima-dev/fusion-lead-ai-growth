import "server-only";
import { openOrganizationSecret } from "@fusion-leap/adapters";
import { createAdminClient } from "../supabase/admin";
import { getKeyRing } from "../smtp/secrets";

/**
 * Lecture du jeton d'une intégration, côté SERVEUR seulement (envois, synchros : J31 et suivants). Seul endroit de l'application web qui
 * rappelle `get_integration_secret` (service_role) : l'entreprise est celle de la ligne du job ou du contexte vérifié, jamais d'un corps
 * de requête. Renvoie `null` sans secret (intégration déconnectée ou inconnue de cette entreprise). Le texte clair ne doit JAMAIS être
 * journalisé, renvoyé au navigateur ni stocké ; toute erreur est opaque (aucun détail du chiffrement).
 */
export async function readIntegrationSecret(organizationId: string, integrationId: string): Promise<string | null> {
  const keyRing = getKeyRing();
  if (!keyRing) throw new Error("secrets_unavailable");
  const { data, error } = await createAdminClient().rpc("get_integration_secret", { p_org: organizationId, p_integration: integrationId });
  if (error) throw new Error("secret_lookup_failed");
  if (data === null || data === undefined) return null;
  const row = data as { secret_id?: unknown; ciphertext?: unknown; nonce?: unknown; key_version?: unknown };
  if (typeof row.secret_id !== "string" || typeof row.ciphertext !== "string" || typeof row.nonce !== "string" || typeof row.key_version !== "number") {
    throw new Error("secret_unreadable");
  }
  try {
    return openOrganizationSecret({
      organizationId,
      stored: { secretId: row.secret_id, ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.key_version },
      keyRing,
    });
  } catch {
    throw new Error("secret_unreadable");
  }
}
