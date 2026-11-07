import { adminOrganizationRowSchema, type AdminOrganizationRow } from "@fusion-leap/domain";
import { createClient } from "../supabase/server";

/**
 * L'utilisateur courant est-il administrateur de la plateforme ? (la base décide d'après auth.uid()).
 * Erreur de lecture => false : on ne devine jamais un droit. Simple commodité d'affichage : chaque fonction
 * d'administration revérifie en base.
 */
export async function isPlatformAdmin(): Promise<boolean> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("is_platform_admin");
    return !error && data === true;
  } catch {
    return false;
  }
}

/** Organisations avec leur abonnement (données d'administration seulement). Erreur => exception générique. */
export async function listAdminOrganizations(limit = 100, offset = 0): Promise<AdminOrganizationRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_list_organizations", { p_limit: limit, p_offset: offset });
  if (error) throw new Error("admin_organizations_lookup_failed");
  const parsed = (Array.isArray(data) ? data : []).map((row) => adminOrganizationRowSchema.safeParse(row));
  if (parsed.some((r) => !r.success)) throw new Error("admin_organizations_lookup_failed");
  return parsed.flatMap((r) => (r.success ? [r.data] : []));
}
