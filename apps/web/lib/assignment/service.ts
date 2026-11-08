import {
  assignmentRuleRowSchema,
  notificationRowSchema,
  type AssignmentRuleRow,
  type CreateAssignmentRuleInput,
  type DeleteAssignmentRuleInput,
  type MarkNotificationReadInput,
  type NotificationRow,
  type UpdateAssignmentRuleInput,
} from "@fusion-leap/domain";
import { mapLeadsDbError } from "../leads/map-error";
import type { ServiceErrorCode } from "../service/errors";
import type { ServerSupabase } from "../tenant/identity";

/**
 * Règles d'assignation, file « non assignés » et notifications in-app (J22, spec §9.1 étape 4, ADR 007). Tout passe par le client
 * serveur de l'utilisateur (RLS + fonctions SQL) : aucune `service_role` ici (l'assignation elle-même est faite par le worker).
 * L'entreprise vient du CONTEXTE VÉRIFIÉ, jamais du corps de la requête.
 */
export type AssignmentResult<T> = { ok: true; value: T } | { ok: false; code: ServiceErrorCode };

const fail = (code: ServiceErrorCode): { ok: false; code: ServiceErrorCode } => ({ ok: false, code });

const RULE_COLUMNS = "id, organization_id, project_id, strategy, eligible_member_ids, cursor, active, created_at, updated_at";
const NOTIFICATION_COLUMNS = "id, organization_id, recipient_id, kind, payload, read_at, created_at";
const LEAD_COLUMNS = "id, organization_id, contact_id, project_id, source, stage_id, assignee_id, created_at, updated_at";
/** Plafond de la file affichée (le nombre exact se lit avec `count`). */
export const UNASSIGNED_PAGE_SIZE = 100;

export async function listAssignmentRules(supabase: ServerSupabase, organizationId: string): Promise<AssignmentRuleRow[]> {
  const { data, error } = await supabase
    .from("assignment_rules")
    .select(RULE_COLUMNS)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error || !Array.isArray(data)) throw new Error("assignment_rules_lookup_failed");
  return data.map((row: unknown) => {
    const parsed = assignmentRuleRowSchema.safeParse(row);
    if (!parsed.success) throw new Error("rows_unreadable");
    return parsed.data;
  });
}

export async function createAssignmentRule(
  supabase: ServerSupabase,
  organizationId: string,
  input: CreateAssignmentRuleInput,
): Promise<AssignmentResult<{ id: string }>> {
  const { data, error } = await supabase.rpc("create_assignment_rule", {
    p_org: organizationId,
    p_project: input.project_id,
    p_strategy: input.strategy,
    p_members: input.eligible_member_ids,
  });
  if (error) return fail(mapLeadsDbError(error));
  return typeof data === "string" ? { ok: true, value: { id: data } } : fail("internal_error");
}

export async function updateAssignmentRule(
  supabase: ServerSupabase,
  organizationId: string,
  input: UpdateAssignmentRuleInput,
): Promise<AssignmentResult<true>> {
  const { error } = await supabase.rpc("update_assignment_rule", {
    p_org: organizationId,
    p_id: input.rule_id,
    p_strategy: input.strategy,
    p_members: input.eligible_member_ids,
    p_active: input.active,
  });
  return error ? fail(mapLeadsDbError(error)) : { ok: true, value: true };
}

export async function deleteAssignmentRule(
  supabase: ServerSupabase,
  organizationId: string,
  input: DeleteAssignmentRuleInput,
): Promise<AssignmentResult<true>> {
  const { error } = await supabase.rpc("delete_assignment_rule", { p_org: organizationId, p_id: input.rule_id });
  return error ? fail(mapLeadsDbError(error)) : { ok: true, value: true };
}

/**
 * File « non assignés » : leads dont l'étape est de genre `unassigned` (la RLS limite la lecture à owner, admin et marketing ;
 * le commercial n'y voit rien, ADR 014). Le plus ancien d'abord.
 */
export async function listUnassignedLeads(
  supabase: ServerSupabase,
  organizationId: string,
): Promise<{ leads: unknown[]; total: number }> {
  const stages = await supabase
    .from("pipeline_stages")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("kind", "unassigned");
  if (stages.error || !Array.isArray(stages.data)) throw new Error("stages_lookup_failed");
  const stageIds = stages.data.map((row: { id: string }) => row.id);
  if (stageIds.length === 0) return { leads: [], total: 0 };
  const { data, error, count } = await supabase
    .from("leads")
    .select(LEAD_COLUMNS, { count: "exact" })
    .eq("organization_id", organizationId)
    .in("stage_id", stageIds)
    .is("assignee_id", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .range(0, UNASSIGNED_PAGE_SIZE - 1);
  if (error || !Array.isArray(data)) throw new Error("unassigned_leads_lookup_failed");
  return { leads: data, total: count ?? data.length };
}

/** Notifications du membre connecté dans l'entreprise courante (la RLS ne montre que les siennes). */
export async function listNotifications(
  supabase: ServerSupabase,
  organizationId: string,
  options: { unreadOnly?: boolean; limit?: number } = {},
): Promise<NotificationRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  let query = supabase.from("notifications").select(NOTIFICATION_COLUMNS).eq("organization_id", organizationId);
  if (options.unreadOnly) query = query.is("read_at", null);
  const { data, error } = await query.order("created_at", { ascending: false }).order("id", { ascending: false }).range(0, limit - 1);
  if (error || !Array.isArray(data)) throw new Error("notifications_lookup_failed");
  return data.map((row: unknown) => {
    const parsed = notificationRowSchema.safeParse(row);
    if (!parsed.success) throw new Error("rows_unreadable");
    return parsed.data;
  });
}

export async function markNotificationRead(
  supabase: ServerSupabase,
  organizationId: string,
  input: MarkNotificationReadInput,
): Promise<AssignmentResult<true>> {
  const { error } = await supabase.rpc("mark_notification_read", { p_org: organizationId, p_id: input.notification_id });
  return error ? fail(mapLeadsDbError(error)) : { ok: true, value: true };
}
