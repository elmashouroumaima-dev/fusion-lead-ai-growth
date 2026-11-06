import { parseServerEnv, type EnvSource, type ServerEnv } from "@fusion-leap/domain";

/**
 * Environnement du worker : même schéma serveur que `apps/web` (le worker utilise la clé secrète
 * Supabase, jamais exposée à un navigateur). Lève `EnvValidationError` si une variable manque.
 */
export function loadWorkerEnv(source: EnvSource = process.env): ServerEnv {
  return parseServerEnv(source);
}
