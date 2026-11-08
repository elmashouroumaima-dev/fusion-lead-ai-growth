import type {
  AssignLeadInput,
  CreateDealInput,
  CreateLeadInput,
  CreatePipelineInput,
  CreateStageInput,
  DealRow,
  DeleteStageInput,
  LeadRow,
  MoveDealStageInput,
  MoveLeadStageInput,
  RenamePipelineInput,
  SetDefaultPipelineInput,
  UpdateDealInput,
  UpdateLeadInput,
  UpdateStageInput,
} from "@fusion-leap/domain";
import type { ServiceErrorCode } from "../service/errors";
import type { ServerSupabase } from "../tenant/identity";
import { mapLeadsDbError } from "./map-error";
import { getDeal, getLead } from "./queries";

/**
 * Opérations sur les pipelines, leads et deals (J19). Chaque écriture passe par une fonction SQL (SECURITY DEFINER) qui relit le
 * rôle de l'appelant (owner / admin, marketing pour créer un lead, commercial sur SES leads), le projet (archivé = lecture seule),
 * la cohérence des étapes et journalise. L'identifiant d'organisation vient du CONTEXTE VÉRIFIÉ, jamais de l'entrée. Les dates
 * gagné / perdu d'un deal sont posées par la base selon le genre de l'étape.
 */
export type LeadsResult<T> = { ok: true; value: T } | { ok: false; code: ServiceErrorCode };

const fail = (code: ServiceErrorCode): { ok: false; code: ServiceErrorCode } => ({ ok: false, code });

async function readLead(supabase: ServerSupabase, organizationId: string, id: string): Promise<LeadRow | null> {
  try {
    return await getLead(supabase, organizationId, id);
  } catch {
    return null;
  }
}

async function readDeal(supabase: ServerSupabase, organizationId: string, id: string): Promise<DealRow | null> {
  try {
    return await getDeal(supabase, organizationId, id);
  } catch {
    return null;
  }
}

/** Appel d'une fonction qui ne renvoie rien. */
async function callVoid(supabase: ServerSupabase, name: string, args: Record<string, unknown>): Promise<LeadsResult<true>> {
  const { error } = await supabase.rpc(name, args);
  return error ? fail(mapLeadsDbError(error)) : { ok: true, value: true };
}

/** Appel d'une fonction qui renvoie l'identifiant créé. */
async function callId(supabase: ServerSupabase, name: string, args: Record<string, unknown>): Promise<LeadsResult<string>> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) return fail(mapLeadsDbError(error));
  return typeof data === "string" ? { ok: true, value: data } : fail("internal_error");
}

// --- Pipelines et étapes (owner / admin) ---------------------------------------------------------------------------------
export const createPipeline = (supabase: ServerSupabase, organizationId: string, input: CreatePipelineInput) =>
  callId(supabase, "create_pipeline", { p_org: organizationId, p_name: input.name });

export const renamePipeline = (supabase: ServerSupabase, organizationId: string, input: RenamePipelineInput) =>
  callVoid(supabase, "rename_pipeline", { p_org: organizationId, p_id: input.pipeline_id, p_name: input.name });

export const setDefaultPipeline = (supabase: ServerSupabase, organizationId: string, input: SetDefaultPipelineInput) =>
  callVoid(supabase, "set_default_pipeline", { p_org: organizationId, p_id: input.pipeline_id });

export const createStage = (supabase: ServerSupabase, organizationId: string, input: CreateStageInput) =>
  callId(supabase, "create_stage", {
    p_org: organizationId,
    p_pipeline: input.pipeline_id,
    p_name: input.name,
    p_kind: input.kind,
    p_position: input.position ?? null,
  });

export const updateStage = (supabase: ServerSupabase, organizationId: string, input: UpdateStageInput) =>
  callVoid(supabase, "update_stage", { p_org: organizationId, p_id: input.stage_id, p_name: input.name, p_position: input.position });

export const deleteStage = (supabase: ServerSupabase, organizationId: string, input: DeleteStageInput) =>
  callVoid(supabase, "delete_stage", { p_org: organizationId, p_id: input.stage_id });

// --- Leads -----------------------------------------------------------------------------------------------------------------------
export async function createLead(supabase: ServerSupabase, organizationId: string, input: CreateLeadInput): Promise<LeadsResult<LeadRow>> {
  const created = await callId(supabase, "create_lead", {
    p_org: organizationId,
    p_contact: input.contact_id,
    p_project: input.project_id,
    p_source: input.source,
    p_assignee: input.assignee_id ?? null,
    p_score: input.score ?? null,
    p_score_reason: input.score_reason ?? {},
    p_utm: input.utm ?? {},
    p_external_source: input.external_source ?? null,
    p_external_id: input.external_id ?? null,
  });
  if (!created.ok) return created;
  const lead = await readLead(supabase, organizationId, created.value);
  return lead ? { ok: true, value: lead } : fail("internal_error");
}

async function leadAfter(supabase: ServerSupabase, organizationId: string, leadId: string, done: Promise<LeadsResult<true>>): Promise<LeadsResult<LeadRow>> {
  const result = await done;
  if (!result.ok) return result;
  const lead = await readLead(supabase, organizationId, leadId);
  return lead ? { ok: true, value: lead } : fail("internal_error");
}

export const updateLead = (supabase: ServerSupabase, organizationId: string, input: UpdateLeadInput) =>
  leadAfter(
    supabase,
    organizationId,
    input.lead_id,
    callVoid(supabase, "update_lead", {
      p_org: organizationId,
      p_id: input.lead_id,
      p_source: input.source,
      p_score: input.score ?? null,
      p_score_reason: input.score_reason ?? {},
      p_utm: input.utm ?? {},
    }),
  );

export const assignLead = (supabase: ServerSupabase, organizationId: string, input: AssignLeadInput) =>
  leadAfter(supabase, organizationId, input.lead_id, callVoid(supabase, "assign_lead", { p_org: organizationId, p_id: input.lead_id, p_assignee: input.assignee_id }));

export const moveLeadStage = (supabase: ServerSupabase, organizationId: string, input: MoveLeadStageInput) =>
  leadAfter(supabase, organizationId, input.lead_id, callVoid(supabase, "move_lead_stage", { p_org: organizationId, p_id: input.lead_id, p_stage: input.stage_id }));

// --- Deals -----------------------------------------------------------------------------------------------------------------------
export async function createDeal(supabase: ServerSupabase, organizationId: string, input: CreateDealInput): Promise<LeadsResult<DealRow>> {
  const created = await callId(supabase, "create_deal", {
    p_org: organizationId,
    p_lead: input.lead_id,
    p_stage: input.stage_id ?? null,
    p_value: input.value,
    p_currency: input.currency,
    p_expected_close_at: input.expected_close_at ?? null,
  });
  if (!created.ok) return created;
  const deal = await readDeal(supabase, organizationId, created.value);
  return deal ? { ok: true, value: deal } : fail("internal_error");
}

async function dealAfter(supabase: ServerSupabase, organizationId: string, dealId: string, done: Promise<LeadsResult<true>>): Promise<LeadsResult<DealRow>> {
  const result = await done;
  if (!result.ok) return result;
  const deal = await readDeal(supabase, organizationId, dealId);
  return deal ? { ok: true, value: deal } : fail("internal_error");
}

export const updateDeal = (supabase: ServerSupabase, organizationId: string, input: UpdateDealInput) =>
  dealAfter(
    supabase,
    organizationId,
    input.deal_id,
    callVoid(supabase, "update_deal", {
      p_org: organizationId,
      p_id: input.deal_id,
      p_value: input.value,
      p_currency: input.currency,
      p_expected_close_at: input.expected_close_at ?? null,
    }),
  );

export const moveDealStage = (supabase: ServerSupabase, organizationId: string, input: MoveDealStageInput) =>
  dealAfter(supabase, organizationId, input.deal_id, callVoid(supabase, "move_deal_stage", { p_org: organizationId, p_id: input.deal_id, p_stage: input.stage_id }));
