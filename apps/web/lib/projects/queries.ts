import {
  productRowSchema,
  projectRowSchema,
  type ProductRow,
  type ProjectRow,
  type ProjectStatus,
} from "@fusion-leap/domain";
import type { ServerSupabase } from "../tenant/identity";

/**
 * Lectures des projets et produits, faites avec les droits de l'utilisateur (client serveur + RLS ; aucune
 * `service_role`). Le filtre `organization_id` est explicite (défense en profondeur : la RLS reste l'autorité). Toute
 * ligne illisible lève une erreur générique.
 */
const PROJECT_COLUMNS = "id, organization_id, type, name, status, owner_id, settings, created_at, updated_at";
const PRODUCT_COLUMNS = "id, organization_id, project_id, kind, offer, price_hint, landing_url, assets, created_at, updated_at";

function parseRows<T>(data: unknown, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }): T[] {
  if (!Array.isArray(data)) throw new Error("rows_unreadable");
  return data.map((row: unknown) => {
    const parsed = schema.safeParse(row);
    if (!parsed.success) throw new Error("rows_unreadable");
    return parsed.data;
  });
}

export async function listProjects(
  supabase: ServerSupabase,
  organizationId: string,
  options: { status?: ProjectStatus } = {},
): Promise<ProjectRow[]> {
  let query = supabase.from("projects").select(PROJECT_COLUMNS).eq("organization_id", organizationId);
  if (options.status) query = query.eq("status", options.status);
  const { data, error } = await query.order("created_at", { ascending: true }).order("id", { ascending: true });
  if (error) throw new Error("projects_lookup_failed");
  return parseRows(data, projectRowSchema);
}

/** Un projet de l'entreprise, ou `null` s'il n'existe pas (ou n'est pas visible). */
export async function getProject(supabase: ServerSupabase, organizationId: string, projectId: string): Promise<ProjectRow | null> {
  const { data, error } = await supabase
    .from("projects")
    .select(PROJECT_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("id", projectId)
    .maybeSingle();
  if (error) throw new Error("projects_lookup_failed");
  if (!data) return null;
  return parseRows([data], projectRowSchema)[0] ?? null;
}

export async function listProducts(supabase: ServerSupabase, organizationId: string, projectId: string): Promise<ProductRow[]> {
  const { data, error } = await supabase
    .from("products")
    .select(PRODUCT_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw new Error("products_lookup_failed");
  return parseRows(data, productRowSchema);
}

export async function getProduct(supabase: ServerSupabase, organizationId: string, productId: string): Promise<ProductRow | null> {
  const { data, error } = await supabase
    .from("products")
    .select(PRODUCT_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("id", productId)
    .maybeSingle();
  if (error) throw new Error("products_lookup_failed");
  if (!data) return null;
  return parseRows([data], productRowSchema)[0] ?? null;
}
