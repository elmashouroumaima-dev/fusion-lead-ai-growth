import { uuidSchema } from "@fusion-leap/domain";
import type { createClient } from "../supabase/server";

export type ServerSupabase = Awaited<ReturnType<typeof createClient>>;

/**
 * Identifiant de l'utilisateur authentifié, issu des claims d'un JWT VÉRIFIÉ (`getClaims()`),
 * jamais de `getSession()` ni de `user_metadata`. `null` si la session est absente ou invalide.
 */
export async function getAuthenticatedUserId(supabase: ServerSupabase): Promise<string | null> {
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) return null;
  const sub = uuidSchema.safeParse(data.claims.sub);
  return sub.success ? sub.data : null;
}
