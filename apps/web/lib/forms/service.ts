import {
  formKeyRowSchema,
  type CreateFormKeyInput,
  type FormKeyRow,
  type SetFormKeyActiveInput,
  type SetFormKeyOriginsInput,
} from "@fusion-leap/domain";
import { mapLeadsDbError } from "../leads/map-error";
import type { ServiceErrorCode } from "../service/errors";
import type { ServerSupabase } from "../tenant/identity";

/**
 * Clés de formulaire des projets (J21, ADR 007 `form_keys`), gérées par owner et admin avec leurs droits (client serveur + RLS ;
 * aucune `service_role`). Écriture par fonctions SQL ; l'entreprise vient du CONTEXTE VÉRIFIÉ. La clé EN CLAIR n'est renvoyée
 * qu'à la création (`createFormKey`) : ni lue ni conservée ailleurs ; la liste n'expose que le préfixe non secret.
 */
export type FormKeyResult<T> = { ok: true; value: T } | { ok: false; code: ServiceErrorCode };

const fail = (code: ServiceErrorCode): { ok: false; code: ServiceErrorCode } => ({ ok: false, code });

/** Colonnes lisibles : l'empreinte de la clé n'est PAS accordée à `authenticated`. */
const FORM_KEY_COLUMNS = "id, organization_id, project_id, key_prefix, allowed_origins, active, created_at, updated_at";

export async function listFormKeys(supabase: ServerSupabase, organizationId: string, projectId: string): Promise<FormKeyRow[]> {
  const { data, error } = await supabase
    .from("form_keys")
    .select(FORM_KEY_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error || !Array.isArray(data)) throw new Error("form_keys_lookup_failed");
  return data.map((row: unknown) => {
    const parsed = formKeyRowSchema.safeParse(row);
    if (!parsed.success) throw new Error("rows_unreadable");
    return parsed.data;
  });
}

/** Crée une clé : `key` (en clair) n'est disponible qu'ICI, une seule fois ; à ne jamais journaliser. */
export async function createFormKey(
  supabase: ServerSupabase,
  organizationId: string,
  input: CreateFormKeyInput,
): Promise<FormKeyResult<{ id: string; key: string; keyPrefix: string }>> {
  const { data, error } = await supabase.rpc("create_form_key", {
    p_org: organizationId,
    p_project: input.project_id,
    p_origins: input.allowed_origins,
  });
  if (error) return fail(mapLeadsDbError(error));
  const row = data as { id?: unknown; key?: unknown; key_prefix?: unknown } | null;
  if (!row || typeof row.id !== "string" || typeof row.key !== "string" || typeof row.key_prefix !== "string") return fail("internal_error");
  return { ok: true, value: { id: row.id, key: row.key, keyPrefix: row.key_prefix } };
}

export async function setFormKeyActive(supabase: ServerSupabase, organizationId: string, input: SetFormKeyActiveInput): Promise<FormKeyResult<true>> {
  const { error } = await supabase.rpc("set_form_key_active", { p_org: organizationId, p_id: input.key_id, p_active: input.active });
  return error ? fail(mapLeadsDbError(error)) : { ok: true, value: true };
}

export async function setFormKeyOrigins(supabase: ServerSupabase, organizationId: string, input: SetFormKeyOriginsInput): Promise<FormKeyResult<true>> {
  const { error } = await supabase.rpc("set_form_key_origins", { p_org: organizationId, p_id: input.key_id, p_origins: input.allowed_origins });
  return error ? fail(mapLeadsDbError(error)) : { ok: true, value: true };
}
