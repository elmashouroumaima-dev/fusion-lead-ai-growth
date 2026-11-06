import { getServerEnv } from "../env/server";

/**
 * URL publique du site, côté serveur uniquement (jamais issue d'une entrée client : un
 * `emailRedirectTo` contrôlé par l'attaquant permettrait du phishing via nos e-mails).
 * Lue via l'environnement serveur validé (zod) : `SITE_URL` est obligatoire en https en
 * staging/production ; en développement, repli sur http://127.0.0.1:3000.
 */
export function getSiteUrl(): string {
  return new URL(getServerEnv().SITE_URL).origin;
}
