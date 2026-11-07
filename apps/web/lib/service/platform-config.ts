import "server-only";
import { decodeBase64, logoSchema, paletteSchema, type LogoMime, type Palette } from "@fusion-leap/domain";
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

/** Clé du logo dans platform_config (liste blanche identique côté SQL). */
export const LOGO_KEY = "appearance.logo";

export type PlatformLogo = { mime: LogoMime; bytes: Uint8Array };

/**
 * Logo GLOBAL de la plateforme, lu côté serveur (service_role, fonction `get_platform_config`). Re-validé
 * (type autorisé, base64 strict, taille, signature) avant d'être servi. Absent, illisible ou erreur => `null`.
 */
export async function getPlatformLogo(): Promise<PlatformLogo | null> {
  try {
    const { data, error } = await createAdminClient().rpc("get_platform_config", { p_key: LOGO_KEY });
    if (error || data === null || data === undefined) return null;
    const parsed = logoSchema.safeParse(data);
    if (!parsed.success) return null;
    const bytes = decodeBase64(parsed.data.data);
    return bytes ? { mime: parsed.data.mime, bytes } : null;
  } catch {
    return null;
  }
}

/**
 * Version du logo (millisecondes de sa dernière modification) pour versionner l'URL sans lire l'image à chaque page.
 * Aucun logo ou erreur => `null` (l'interface garde le logo par défaut).
 */
export async function getPlatformLogoVersion(): Promise<number | null> {
  try {
    const { data, error } = await createAdminClient().rpc("get_platform_config_updated_at", { p_key: LOGO_KEY });
    if (error || typeof data !== "string") return null;
    const ms = Date.parse(data);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}
