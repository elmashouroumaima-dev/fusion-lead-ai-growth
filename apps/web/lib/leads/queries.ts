import {
  dealRowSchema,
  leadRowSchema,
  pipelineRowSchema,
  pipelineStageRowSchema,
  type DealRow,
  type LeadRow,
  type PipelineRow,
  type PipelineStageRow,
} from "@fusion-leap/domain";
import type { ServerSupabase } from "../tenant/identity";

/**
 * Lectures des pipelines, étapes, leads et deals, faites avec les droits de l'utilisateur (client serveur + RLS : owner, admin et
 * marketing voient tous les leads, le commercial les siens, l'analyste aucun ; aucune `service_role`). Le filtre
 * `organization_id` est explicite (défense en profondeur). Toute ligne illisible lève une erreur générique.
 */
const PIPELINE_COLUMNS = "id, organization_id, name, is_default, created_at, updated_at";
const STAGE_COLUMNS = "id, organization_id, pipeline_id, name, position, kind, created_at, updated_at";
const LEAD_COLUMNS =
  "id, organization_id, contact_id, project_id, source, stage_id, score, score_reason, assignee_id, campaign_id, utm, external_source, external_id, created_at, updated_at";
const DEAL_COLUMNS =
  "id, organization_id, lead_id, stage_id, value, currency, expected_close_at, won_at, lost_at, external_source, external_id, created_at, updated_at";

function parseRows<T>(data: unknown, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }): T[] {
  if (!Array.isArray(data)) throw new Error("rows_unreadable");
  return data.map((row: unknown) => {
    const parsed = schema.safeParse(row);
    if (!parsed.success) throw new Error("rows_unreadable");
    return parsed.data;
  });
}

export const LEADS_PAGE_SIZE = 50;

export async function listPipelines(supabase: ServerSupabase, organizationId: string): Promise<PipelineRow[]> {
  const { data, error } = await supabase
    .from("pipelines")
    .select(PIPELINE_COLUMNS)
    .eq("organization_id", organizationId)
    .order("is_default", { ascending: false })
    .order("name", { ascending: true });
  if (error) throw new Error("pipelines_lookup_failed");
  return parseRows(data, pipelineRowSchema);
}

/** Étapes de l'entreprise (d'un pipeline si précisé), dans l'ordre d'affichage. */
export async function listStages(supabase: ServerSupabase, organizationId: string, pipelineId?: string): Promise<PipelineStageRow[]> {
  let query = supabase.from("pipeline_stages").select(STAGE_COLUMNS).eq("organization_id", organizationId);
  if (pipelineId) query = query.eq("pipeline_id", pipelineId);
  const { data, error } = await query.order("position", { ascending: true }).order("id", { ascending: true });
  if (error) throw new Error("stages_lookup_failed");
  return parseRows(data, pipelineStageRowSchema);
}

export async function listLeads(
  supabase: ServerSupabase,
  organizationId: string,
  options: { stageId?: string; assigneeId?: string; projectId?: string; limit?: number; offset?: number } = {},
): Promise<LeadRow[]> {
  const limit = Math.min(Math.max(options.limit ?? LEADS_PAGE_SIZE, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  let query = supabase.from("leads").select(LEAD_COLUMNS).eq("organization_id", organizationId);
  if (options.stageId) query = query.eq("stage_id", options.stageId);
  if (options.assigneeId) query = query.eq("assignee_id", options.assigneeId);
  if (options.projectId) query = query.eq("project_id", options.projectId);
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw new Error("leads_lookup_failed");
  return parseRows(data, leadRowSchema);
}

/** Un lead visible de l'entreprise, ou `null` (absent, autre entreprise, ou lead d'un autre commercial). */
export async function getLead(supabase: ServerSupabase, organizationId: string, leadId: string): Promise<LeadRow | null> {
  const { data, error } = await supabase.from("leads").select(LEAD_COLUMNS).eq("organization_id", organizationId).eq("id", leadId).maybeSingle();
  if (error) throw new Error("leads_lookup_failed");
  if (!data) return null;
  return parseRows([data], leadRowSchema)[0] ?? null;
}

export async function listDeals(supabase: ServerSupabase, organizationId: string, options: { leadId?: string } = {}): Promise<DealRow[]> {
  let query = supabase.from("deals").select(DEAL_COLUMNS).eq("organization_id", organizationId);
  if (options.leadId) query = query.eq("lead_id", options.leadId);
  const { data, error } = await query.order("created_at", { ascending: false }).order("id", { ascending: true });
  if (error) throw new Error("deals_lookup_failed");
  return parseRows(data, dealRowSchema);
}

export async function getDeal(supabase: ServerSupabase, organizationId: string, dealId: string): Promise<DealRow | null> {
  const { data, error } = await supabase.from("deals").select(DEAL_COLUMNS).eq("organization_id", organizationId).eq("id", dealId).maybeSingle();
  if (error) throw new Error("deals_lookup_failed");
  if (!data) return null;
  return parseRows([data], dealRowSchema)[0] ?? null;
}
