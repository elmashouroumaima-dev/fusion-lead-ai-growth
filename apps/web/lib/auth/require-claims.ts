import { localeSchema, type AuthLocale } from "@fusion-leap/domain";
import { redirect } from "next/navigation";
import { createClient } from "../supabase/server";
import { DEFAULT_LOCALE } from "./routes";

/**
 * Défense en profondeur pour les pages/layouts privés (Server Components) : revalide l'identité
 * côté serveur via `getClaims()` (JWT vérifié, jamais `getSession()`) et redirige vers la page
 * de connexion de la locale si elle est absente ou invalide. Le proxy reste la première barrière ;
 * celle-ci couvre les chemins qu'il n'intercepte pas (matcher, contournement).
 * Retourne les claims vérifiés. `redirect()` lève NEXT_REDIRECT : ne pas l'entourer d'un try/catch.
 */
export async function requireClaims(locale: string): Promise<Record<string, unknown>> {
  const parsed = localeSchema.safeParse(locale);
  const safeLocale: AuthLocale = parsed.success ? parsed.data : DEFAULT_LOCALE;

  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) redirect(`/${safeLocale}/login`);
  return data.claims as Record<string, unknown>;
}
