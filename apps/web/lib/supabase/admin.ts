import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getServerEnv } from "../env/server";
import { requestIdHeaders } from "../service/request-context";

/**
 * Client Supabase « service_role » (clé secrète, contourne la RLS). SEUL module de apps/web autorisé
 * à le créer (J11, décision du responsable technique) :
 *  - importable uniquement depuis `apps/web/lib/service/**` et les fichiers de test (règle ESLint
 *    `no-restricted-imports` + test de confinement) ;
 *  - `import "server-only"` : toute inclusion dans un bundle client échoue à la compilation ;
 *  - la clé vient de l'environnement serveur validé (jamais NEXT_PUBLIC_*), aucune session persistée.
 * Usages actuels : limitation de débit (`rate_limit_take`, table `rate_limit_buckets`) et lecture de la
 * palette GLOBALE de la plateforme (`get_platform_config`, J12b, ADR 016 : donnée non tenant, non sensible).
 * Ne jamais s'en servir pour lire ou écrire des données métier d'une organisation.
 */
export function createAdminClient() {
  const env = getServerEnv();
  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: requestIdHeaders() },
  });
}
