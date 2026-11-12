import {
  LEADS_EXPORT_MAX_ROWS,
  LEADS_PAGE_SIZE,
  activeFilterNames,
  leadListRowSchema,
  type LeadListFilters,
  type LeadListRow,
} from "@fusion-leap/domain";
import { mapLeadsDbError } from "../leads/map-error";
import type { ServiceErrorCode } from "../service/errors";
import type { ServerSupabase } from "../tenant/identity";

/**
 * Liste, recherche, export et tableau des deals (J24). Tout passe par le client serveur de l'UTILISATEUR : la RLS décide de ce qui est
 * visible (owner, admin et marketing : tous les leads ; commercial : les siens ; analyste : rien) et `search_leads` est SECURITY INVOKER.
 * L'entreprise vient du CONTEXTE VÉRIFIÉ. Aucune `service_role`.
 */
export type CrmResult<T> = { ok: true; value: T } | { ok: false; code: ServiceErrorCode };
const fail = (code: ServiceErrorCode): { ok: false; code: ServiceErrorCode } => ({ ok: false, code });

function searchArgs(organizationId: string, filters: LeadListFilters, limit: number, offset: number) {
  return {
    p_org: organizationId,
    p_project: filters.project,
    p_stage: filters.stage,
    p_source: filters.source,
    p_assignee: filters.assignee,
    p_unassigned: filters.unassigned,
    p_query: filters.query,
    p_sort: filters.sort,
    p_limit: limit,
    p_offset: offset,
  };
}

function parseRows(data: unknown): LeadListRow[] {
  if (!Array.isArray(data)) throw new Error("rows_unreadable");
  return data.map((row: unknown) => {
    const parsed = leadListRowSchema.safeParse(row);
    if (!parsed.success) throw new Error("rows_unreadable");
    return parsed.data;
  });
}

export type LeadPage = { rows: LeadListRow[]; total: number; page: number; pageSize: number; pageCount: number };

/** Une page de leads (25 par page), filtrée et recherchée côté serveur. */
export async function searchLeads(supabase: ServerSupabase, organizationId: string, filters: LeadListFilters, page: number): Promise<LeadPage> {
  const { data, error } = await supabase.rpc("search_leads", searchArgs(organizationId, filters, LEADS_PAGE_SIZE, (page - 1) * LEADS_PAGE_SIZE));
  if (error) throw new Error("leads_search_failed");
  const rows = parseRows(data);
  let total = rows[0]?.total_count ?? 0;
  if (rows.length === 0 && page > 1) {
    // page au-delà du total : la fonction ne renvoie aucune ligne donc aucun total ; on le relit (1 ligne) pour garder la navigation
    const first = await supabase.rpc("search_leads", searchArgs(organizationId, filters, 1, 0));
    if (first.error) throw new Error("leads_search_failed");
    total = parseRows(first.data)[0]?.total_count ?? 0;
  }
  return { rows, total, page, pageSize: LEADS_PAGE_SIZE, pageCount: Math.max(1, Math.ceil(total / LEADS_PAGE_SIZE)) };
}

/**
 * Export : les mêmes filtres, 10 000 lignes au plus, puis l'audit `export.created` (nombre de lignes et NOMS des filtres). L'audit est
 * écrit AVANT de rendre les lignes : sans audit, pas d'export. Rôle owner / admin (la fonction SQL le revérifie).
 */
export async function exportLeads(supabase: ServerSupabase, organizationId: string, filters: LeadListFilters): Promise<CrmResult<LeadListRow[]>> {
  const { data, error } = await supabase.rpc("search_leads", searchArgs(organizationId, filters, LEADS_EXPORT_MAX_ROWS, 0));
  if (error) return fail(mapLeadsDbError(error));
  let rows: LeadListRow[];
  try {
    rows = parseRows(data);
  } catch {
    return fail("internal_error");
  }
  // Revue sécurité : jamais d'export TRONQUÉ en silence (le fichier et l'audit annonceraient 10 000 lignes) : on demande d'affiner.
  if ((rows[0]?.total_count ?? 0) > LEADS_EXPORT_MAX_ROWS) return fail("payload_too_large");
  const logged = await supabase.rpc("log_export", {
    p_org: organizationId,
    p_kind: "leads",
    p_count: rows.length,
    p_filters: activeFilterNames(filters),
  });
  if (logged.error) return fail(mapLeadsDbError(logged.error));
  return { ok: true, value: rows };
}

export type BoardDeal = {
  id: string;
  stageId: string;
  value: number | null;
  currency: string;
  leadId: string;
  contactName: string | null;
  assigneeId: string | null;
};

/** Plafond de deals affichés sur le tableau (le reste se trouve par la liste filtrée). */
export const BOARD_MAX_DEALS = 500;

/** Deals de l'entreprise avec le nom du contact de leur lead (RLS : le commercial ne voit que les siens). */
export async function listBoardDeals(supabase: ServerSupabase, organizationId: string, options: { projectId?: string | null } = {}): Promise<BoardDeal[]> {
  let query = supabase
    .from("deals")
    .select("id, stage_id, value, currency, lead_id, leads!inner(assignee_id, project_id, contacts(name))")
    .eq("organization_id", organizationId);
  if (options.projectId) query = query.eq("leads.project_id", options.projectId);
  const { data, error } = await query.order("created_at", { ascending: false }).order("id", { ascending: false }).range(0, BOARD_MAX_DEALS - 1);
  if (error || !Array.isArray(data)) throw new Error("deals_board_failed");
  return data.map((row: unknown) => {
    const r = row as {
      id?: unknown; stage_id?: unknown; value?: unknown; currency?: unknown; lead_id?: unknown;
      leads?: { assignee_id?: unknown; contacts?: { name?: unknown } | null } | null;
    };
    if (typeof r.id !== "string" || typeof r.stage_id !== "string" || typeof r.lead_id !== "string" || typeof r.currency !== "string") throw new Error("rows_unreadable");
    const value = r.value === null || r.value === undefined ? null : Number(r.value);
    return {
      id: r.id,
      stageId: r.stage_id,
      value: value !== null && Number.isFinite(value) ? value : null,
      currency: r.currency,
      leadId: r.lead_id,
      contactName: typeof r.leads?.contacts?.name === "string" ? r.leads.contacts.name : null,
      assigneeId: typeof r.leads?.assignee_id === "string" ? r.leads.assignee_id : null,
    };
  });
}
