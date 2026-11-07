import { createClient } from "../supabase/server";

/**
 * L'utilisateur courant peut-il modifier la palette globale ? (owner ou admin actif d'une organisation ; la base
 * décide d'après auth.uid()). Erreur de lecture => false : on ne devine jamais un droit. Simple commodité
 * d'affichage : set_platform_config revérifie à l'écriture.
 */
export async function canManagePlatformConfig(): Promise<boolean> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("can_manage_platform_config");
    return !error && data === true;
  } catch {
    return false;
  }
}
