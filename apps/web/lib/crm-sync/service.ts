import {
  CRM_PROVIDERS,
  crmIntegrationRowSchema,
  crmMappingRowSchema,
  type CreateCrmIntegrationInput,
  type CrmIntegrationRow,
  type CrmMappingRow,
  type RequestCrmSyncInput,
  type RetryCrmSyncInput,
  type SaveCrmMappingsInput,
} from "@fusion-leap/domain";
import { mapLeadsDbError } from "../leads/map-error";
import type { ServiceErrorCode } from "../service/errors";
import type { ServerSupabase } from "../tenant/identity";

/**
 * Intégrations CRM, mapping de champs, demande, rejeu et statut de synchro (J25). Tout passe par le client serveur de l'UTILISATEUR
 * (RLS : owner et admin seulement + fonctions SQL qui revérifient le rôle) ; aucune `service_role` ici (la synchro est faite par le
 * worker). L'entreprise vient du CONTEXTE VÉRIFIÉ, jamais du corps.
 */
export type CrmSyncResult<T> = { ok: true; value: T } | { ok: false; code: ServiceErrorCode };
const fail = (code: ServiceErrorCode): { ok: false; code: ServiceErrorCode } => ({ ok: false, code });

const INTEGRATION_COLUMNS = "id, organization_id, provider, status, external_account_id, last_sync_at, last_error, created_at, updated_at";
const MAPPING_COLUMNS = "id, integration_id, entity, internal_field, external_field, source_of_truth, direction";

export type SyncStatus = "never" | "queued" | "running" | "ok" | "failed";
export type IntegrationView = { integration: CrmIntegrationRow; mappings: CrmMappingRow[]; sync: { status: SyncStatus; lastSyncAt: string | null; lastError: string | null } };

const STATUSES: readonly SyncStatus[] = ["never", "queued", "running", "ok", "failed"];

/** Intégrations de l'entreprise avec leur mapping et leur statut de synchro (une lecture par intégration, 20 au plus). */
export async function listIntegrations(supabase: ServerSupabase, organizationId: string): Promise<IntegrationView[]> {
  const { data, error } = await supabase
    .from("integrations")
    .select(INTEGRATION_COLUMNS)
    .eq("organization_id", organizationId)
    .in("provider", CRM_PROVIDERS)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error || !Array.isArray(data)) throw new Error("integrations_lookup_failed");
  const integrations = data.map((row: unknown) => {
    const parsed = crmIntegrationRowSchema.safeParse(row);
    if (!parsed.success) throw new Error("rows_unreadable");
    return parsed.data;
  });
  const views: IntegrationView[] = [];
  for (const integration of integrations) {
    const mappings = await supabase
      .from("crm_field_mappings")
      .select(MAPPING_COLUMNS)
      .eq("organization_id", organizationId)
      .eq("integration_id", integration.id)
      .order("internal_field", { ascending: true });
    if (mappings.error || !Array.isArray(mappings.data)) throw new Error("mappings_lookup_failed");
    const status = await supabase.rpc("crm_sync_status", { p_org: organizationId, p_integration: integration.id });
    if (status.error) throw new Error("sync_status_failed");
    const raw = status.data as { status?: unknown; last_sync_at?: unknown; last_error?: unknown } | null;
    const label = typeof raw?.status === "string" && (STATUSES as readonly string[]).includes(raw.status) ? (raw.status as SyncStatus) : "never";
    views.push({
      integration,
      mappings: mappings.data.map((row: unknown) => {
        const parsed = crmMappingRowSchema.safeParse(row);
        if (!parsed.success) throw new Error("rows_unreadable");
        return parsed.data;
      }),
      sync: { status: label, lastSyncAt: typeof raw?.last_sync_at === "string" ? raw.last_sync_at : null, lastError: typeof raw?.last_error === "string" ? raw.last_error : null },
    });
  }
  return views;
}

export async function createIntegration(supabase: ServerSupabase, organizationId: string, input: CreateCrmIntegrationInput): Promise<CrmSyncResult<{ id: string }>> {
  const { data, error } = await supabase.rpc("create_integration", { p_org: organizationId, p_provider: input.provider, p_account: input.external_account_id });
  if (error) return fail(mapLeadsDbError(error));
  return typeof data === "string" ? { ok: true, value: { id: data } } : fail("internal_error");
}

export async function saveMappings(supabase: ServerSupabase, organizationId: string, input: SaveCrmMappingsInput): Promise<CrmSyncResult<true>> {
  const { error } = await supabase.rpc("save_crm_mappings", { p_org: organizationId, p_integration: input.integration_id, p_mappings: input.mappings });
  return error ? fail(mapLeadsDbError(error)) : { ok: true, value: true };
}

/** Demande une synchro à partir d'un fichier CSV déjà envoyé : la base enfile le job `crm_sync` (jamais dans la requête HTTP). */
export async function requestSync(supabase: ServerSupabase, organizationId: string, input: RequestCrmSyncInput): Promise<CrmSyncResult<{ jobId: string }>> {
  const { data, error } = await supabase.rpc("request_crm_sync", { p_org: organizationId, p_integration: input.integration_id, p_batch: input.batch_id });
  if (error) return fail(mapLeadsDbError(error));
  return typeof data === "string" ? { ok: true, value: { jobId: data } } : fail("internal_error");
}

/** Rejoue la dernière synchro en échec ; `retried: false` si rien n'était à rejouer. */
export async function retrySync(supabase: ServerSupabase, organizationId: string, input: RetryCrmSyncInput): Promise<CrmSyncResult<{ retried: boolean }>> {
  const { data, error } = await supabase.rpc("retry_crm_sync", { p_org: organizationId, p_integration: input.integration_id });
  if (error) return fail(mapLeadsDbError(error));
  return { ok: true, value: { retried: data === true } };
}
