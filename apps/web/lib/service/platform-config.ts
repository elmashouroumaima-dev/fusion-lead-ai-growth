import "server-only";
import { paletteSchema, type Palette } from "@fusion-leap/domain";
import { createAdminClient } from "../supabase/admin";

/** Clé de la palette dans platform_config (liste blanche identique côté SQL). */
export const PALETTE_KEY = "appearance.palette";

/**
 * Palette GLOBALE de la plateforme (données non tenant), lue côté serveur avec le client service_role :
 * les pages de connexion en ont besoin avant toute session et `anon` n'a aucun droit sur la table. Seule la
 * fonction `get_platform_config` (liste blanche de clés) est appelée ; aucune donnée d'organisation n'est lue.
 * Aucune ligne, erreur de lecture ou valeur illisible => `null` : l'application garde ses couleurs par défaut
 * (une configuration ne doit jamais empêcher l'affichage d'une page). Valeur re-validée (hex uniquement).
 */
export async function getPlatformPalette(): Promise<Palette | null> {
  try {
    const { data, error } = await createAdminClient().rpc("get_platform_config", { p_key: PALETTE_KEY });
    if (error || data === null || data === undefined) return null;
    const parsed = paletteSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
