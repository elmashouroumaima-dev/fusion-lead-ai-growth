import { parseServerEnv, type ServerEnv } from "@fusion-leap/domain";

let cached: ServerEnv | undefined;

/**
 * Environnement serveur validé (contient des secrets). Utilisable uniquement côté serveur :
 * l'appel depuis le navigateur est refusé (spec §6, invariant 7).
 * La première lecture valide `process.env` ; en cas d'échec, l'erreur nomme les variables
 * fautives sans jamais afficher leurs valeurs.
 */
export function getServerEnv(): ServerEnv {
  if (typeof window !== "undefined") {
    throw new Error("getServerEnv() est interdit dans le navigateur (secrets serveur).");
  }
  cached ??= parseServerEnv(process.env);
  return cached;
}

/** Réservé aux tests. */
export function resetServerEnvCacheForTests(): void {
  cached = undefined;
}
