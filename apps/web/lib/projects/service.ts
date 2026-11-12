import {
  parseProjectSettings,
  type CreateProductInput,
  type CreateProjectInput,
  type ProductRow,
  type ProjectRow,
  type SetProjectStatusInput,
  type UpdateProductInput,
  type UpdateProjectInput,
} from "@fusion-leap/domain";
import type { ServiceErrorCode } from "../service/errors";
import type { ServerSupabase } from "../tenant/identity";
import { mapProjectsDbError } from "./map-error";
import { getProduct, getProject } from "./queries";

/**
 * Opérations sur les projets et produits (J16). Chaque écriture passe par une fonction SQL (SECURITY DEFINER) qui relit
 * le rôle de l'appelant, applique le quota « projects » et journalise ; ici : validation de la forme des réglages selon
 * le type (zod), puis appel avec les droits de l'utilisateur. L'identifiant d'organisation vient du CONTEXTE VÉRIFIÉ,
 * jamais de l'entrée. Résultats sous forme `{ ok, … }` : le code d'erreur est celui de la couche service.
 */
export type ServiceResult<T> = { ok: true; value: T } | { ok: false; code: ServiceErrorCode };

const fail = (code: ServiceErrorCode): { ok: false; code: ServiceErrorCode } => ({ ok: false, code });

export async function createProject(
  supabase: ServerSupabase,
  organizationId: string,
  input: CreateProjectInput,
): Promise<ServiceResult<ProjectRow>> {
  const { data, error } = await supabase.rpc("create_project", {
    p_org: organizationId,
    p_type: input.type,
    p_name: input.name,
    p_settings: input.settings,
    p_owner: input.owner_id ?? null,
  });
  if (error) return fail(mapProjectsDbError(error));
  if (typeof data !== "string") return fail("internal_error");
  const row = await readBack(() => getProject(supabase, organizationId, data));
  return row ? { ok: true, value: row } : fail("internal_error");
}

export async function updateProject(
  supabase: ServerSupabase,
  organizationId: string,
  input: UpdateProjectInput,
): Promise<ServiceResult<ProjectRow>> {
  // Le type (immuable) donne la forme des réglages ; un projet absent ou d'une autre entreprise est « introuvable ».
  let current: ProjectRow | null;
  try {
    current = await getProject(supabase, organizationId, input.project_id);
  } catch {
    return fail("internal_error");
  }
  if (!current) return fail("not_found");
  const settings = parseProjectSettings(current.type, input.settings);
  if (!settings.success) return fail("validation_failed");

  const { error } = await supabase.rpc("update_project", {
    p_org: organizationId,
    p_id: input.project_id,
    p_name: input.name,
    p_settings: settings.data,
    // Propriétaire non précisé : conservé ; `null` explicite : retiré.
    p_owner: input.owner_id === undefined ? current.owner_id : input.owner_id,
  });
  if (error) return fail(mapProjectsDbError(error));
  const row = await readBack(() => getProject(supabase, organizationId, input.project_id));
  return row ? { ok: true, value: row } : fail("internal_error");
}

/** Archive ou réactive un projet (la réactivation consomme de nouveau le quota). */
export async function setProjectStatus(
  supabase: ServerSupabase,
  organizationId: string,
  input: SetProjectStatusInput,
): Promise<ServiceResult<ProjectRow>> {
  const { error } = await supabase.rpc("set_project_status", {
    p_org: organizationId,
    p_id: input.project_id,
    p_status: input.status,
  });
  if (error) return fail(mapProjectsDbError(error));
  const row = await readBack(() => getProject(supabase, organizationId, input.project_id));
  return row ? { ok: true, value: row } : fail("internal_error");
}

export async function createProduct(
  supabase: ServerSupabase,
  organizationId: string,
  input: CreateProductInput,
): Promise<ServiceResult<ProductRow>> {
  const { data, error } = await supabase.rpc("create_product", {
    p_org: organizationId,
    p_project: input.project_id,
    p_kind: input.kind,
    p_offer: input.offer,
    p_price_hint: input.price_hint ?? null,
    p_landing_url: input.landing_url ?? null,
    p_assets: [],
  });
  if (error) return fail(mapProjectsDbError(error));
  if (typeof data !== "string") return fail("internal_error");
  const row = await readBack(() => getProduct(supabase, organizationId, data));
  return row ? { ok: true, value: row } : fail("internal_error");
}

export async function updateProduct(
  supabase: ServerSupabase,
  organizationId: string,
  input: UpdateProductInput,
): Promise<ServiceResult<ProductRow>> {
  const { error } = await supabase.rpc("update_product", {
    p_org: organizationId,
    p_id: input.product_id,
    p_kind: input.kind,
    p_offer: input.offer,
    p_price_hint: input.price_hint ?? null,
    p_landing_url: input.landing_url ?? null,
    // Ignoré côté base (les fichiers se modifient par append_product_asset / remove_product_asset).
    p_assets: [],
  });
  if (error) return fail(mapProjectsDbError(error));
  const row = await readBack(() => getProduct(supabase, organizationId, input.product_id));
  return row ? { ok: true, value: row } : fail("internal_error");
}

/** Relit la ligne après écriture ; une lecture qui échoue donne `null`, jamais une exception. */
async function readBack<T>(read: () => Promise<T | null>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}
