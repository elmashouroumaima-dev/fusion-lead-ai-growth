import { activityRowSchema, nextAction, type ActivityRow } from "@fusion-leap/domain";
import type { ServerSupabase } from "../tenant/identity";

/**
 * Lectures de la chronologie et des tâches, faites avec les droits de l'utilisateur (client serveur + RLS : owner, admin et
 * marketing voient tout, le commercial les activités de SES leads, l'analyste aucune ; aucune `service_role`). Le filtre
 * `organization_id` est explicite (défense en profondeur). Les valeurs de filtre passent par `.eq()` / `.in()` (jamais dans une
 * chaîne de filtre).
 */
const COLUMNS = "id, organization_id, lead_id, contact_id, type, owner_id, due_at, completed_at, metadata, created_at, updated_at";

function parseRows(data: unknown): ActivityRow[] {
  if (!Array.isArray(data)) throw new Error("rows_unreadable");
  return data.map((row: unknown) => {
    const parsed = activityRowSchema.safeParse(row);
    if (!parsed.success) throw new Error("rows_unreadable");
    return parsed.data;
  });
}

export const TIMELINE_PAGE_SIZE = 50;
export const NEXT_ACTIONS_MAX_LEADS = 200;

/** Chronologie d'un lead : la plus récente d'abord. */
export async function listTimeline(
  supabase: ServerSupabase,
  organizationId: string,
  leadId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<ActivityRow[]> {
  const limit = Math.min(Math.max(options.limit ?? TIMELINE_PAGE_SIZE, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const { data, error } = await supabase
    .from("activities")
    .select(COLUMNS)
    .eq("organization_id", organizationId)
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw new Error("activities_lookup_failed");
  return parseRows(data);
}

/**
 * Tâches ouvertes dont l'échéance est atteinte à l'instant donné (les plus en retard d'abord), pour un responsable si précisé.
 */
export async function listDueTasks(
  supabase: ServerSupabase,
  organizationId: string,
  options: { ownerId?: string; now?: Date; limit?: number } = {},
): Promise<ActivityRow[]> {
  const limit = Math.min(Math.max(options.limit ?? TIMELINE_PAGE_SIZE, 1), 200);
  let query = supabase
    .from("activities")
    .select(COLUMNS)
    .eq("organization_id", organizationId)
    .eq("type", "task")
    .is("completed_at", null)
    .not("due_at", "is", null)
    .lte("due_at", (options.now ?? new Date()).toISOString());
  if (options.ownerId) query = query.eq("owner_id", options.ownerId);
  const { data, error } = await query.order("due_at", { ascending: true }).order("id", { ascending: true }).limit(limit);
  if (error) throw new Error("activities_lookup_failed");
  return parseRows(data);
}

/**
 * Prochaine action de plusieurs leads en une lecture : leur première tâche ouverte (échéance la plus proche, sans échéance en
 * dernier). Un lead sans tâche ouverte est absent du résultat. 200 leads au plus par appel.
 */
export async function nextActionsFor(
  supabase: ServerSupabase,
  organizationId: string,
  leadIds: readonly string[],
): Promise<Map<string, ActivityRow>> {
  const unique = [...new Set(leadIds)].slice(0, NEXT_ACTIONS_MAX_LEADS);
  const result = new Map<string, ActivityRow>();
  if (unique.length === 0) return result;
  const { data, error } = await supabase
    .from("activities")
    .select(COLUMNS)
    .eq("organization_id", organizationId)
    .eq("type", "task")
    .is("completed_at", null)
    .in("lead_id", unique);
  if (error) throw new Error("activities_lookup_failed");
  const byLead = new Map<string, ActivityRow[]>();
  for (const row of parseRows(data)) byLead.set(row.lead_id, [...(byLead.get(row.lead_id) ?? []), row]);
  for (const [leadId, rows] of byLead) {
    const next = nextAction(rows);
    if (next) result.set(leadId, next);
  }
  return result;
}

export async function getActivity(supabase: ServerSupabase, organizationId: string, activityId: string): Promise<ActivityRow | null> {
  const { data, error } = await supabase
    .from("activities")
    .select(COLUMNS)
    .eq("organization_id", organizationId)
    .eq("id", activityId)
    .maybeSingle();
  if (error) throw new Error("activities_lookup_failed");
  if (!data) return null;
  return parseRows([data])[0] ?? null;
}
