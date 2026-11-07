import "server-only";
import { createKeyRing, type KeyRing } from "@fusion-leap/adapters";
import { getServerEnv } from "../env/server";

/**
 * Trousseau de clés du chiffrement des secrets (ADR 004), depuis l'environnement serveur. `null` si la clé maître
 * n'est pas configurée : les fonctions qui stockent un secret sont alors désactivées (jamais de repli en clair).
 */
export function getKeyRing(): KeyRing | null {
  try {
    const env = getServerEnv();
    if (!env.SECRETS_MASTER_KEY) return null;
    return createKeyRing(env.SECRETS_KEY_VERSION, { [env.SECRETS_KEY_VERSION]: env.SECRETS_MASTER_KEY });
  } catch {
    return null;
  }
}

/** Usage du secret du mot de passe SMTP : fait partie des données associées (AAD) du chiffrement. */
export const SMTP_SECRET_PURPOSE = "smtp";
