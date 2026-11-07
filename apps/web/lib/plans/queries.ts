import { usageRowSchema, type UsageRow } from "@fusion-leap/domain";
import { createClient } from "../supabase/server";

/**
 * Usage du plan de l'organisation (owner / admin ; la base refuse tout autre appelant). Lecture d'affichage :
 * toute erreur ou ligne illisible donne une liste vide (l'interface n'affiche alors rien), jamais une exception.
 */
export async function getOrganizationUsage(organizationId: string): Promise<UsageRow[]> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("get_org_usage", { p_org: organizationId });
    if (error) return [];
    const parsed = (Array.isArray(data) ? data : []).map((row) => usageRowSchema.safeParse(row));
    return parsed.every((r) => r.success) ? parsed.flatMap((r) => (r.success ? [r.data] : [])) : [];
  } catch {
    return [];
  }
}
