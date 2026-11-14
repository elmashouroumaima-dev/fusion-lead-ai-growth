import { CONVERSATION_STATES, INBOX_CHANNELS, inboxRowSchema, type ConversationState, type InboxChannel, type InboxRow } from "@fusion-leap/domain";
import type { ServerSupabase } from "../tenant/identity";

/**
 * Lecture de la boîte de réception (J37) par `search_conversations` : la conversation, le nom du contact, le type du canal et un
 * APERÇU tronqué du dernier message. La fonction réapplique les droits de lecture des conversations (owner et admin toutes, le commercial
 * SES conversations, marketing et analyste aucune) ; le filtre d'entreprise vient du contexte vérifié. La saisie de recherche n'est jamais
 * un motif (la fonction échappe `%`, `_` et `\`). Une erreur lève une exception générique : l'écran affiche un message neutre.
 */
export const INBOX_PAGE_SIZE = 25;

export type InboxAssigneeFilter = "all" | "me" | "none";
export type InboxFilters = { state: ConversationState | null; channel: InboxChannel | null; assignee: InboxAssigneeFilter; query: string | null };
export type InboxPage = { rows: InboxRow[]; total: number; page: number; pageSize: number; pageCount: number };

const QUERY_MAX = 100;
const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/** Paramètres d'URL -> filtres : toute valeur inconnue est ignorée (jamais transmise à la base). */
export function parseInboxParams(raw: Record<string, string | string[] | undefined>): { filters: InboxFilters; page: number } {
  const state = first(raw.state);
  const channel = first(raw.channel);
  const assignee = first(raw.assignee);
  const query = (first(raw.q) ?? "").trim().slice(0, QUERY_MAX);
  const page = Number.parseInt(first(raw.page) ?? "1", 10);
  return {
    filters: {
      state: (CONVERSATION_STATES as readonly string[]).includes(state ?? "") ? (state as ConversationState) : null,
      channel: (INBOX_CHANNELS as readonly string[]).includes(channel ?? "") ? (channel as InboxChannel) : null,
      assignee: assignee === "me" || assignee === "none" ? assignee : "all",
      query: query === "" ? null : query,
    },
    page: Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
  };
}

/** Adresse relative de la liste avec ces filtres (liens de pagination et réinitialisation). */
export function inboxHref(filters: InboxFilters, page = 1): string {
  const params = new URLSearchParams();
  if (filters.state) params.set("state", filters.state);
  if (filters.channel) params.set("channel", filters.channel);
  if (filters.assignee !== "all") params.set("assignee", filters.assignee);
  if (filters.query) params.set("q", filters.query);
  if (page > 1) params.set("page", String(page));
  const text = params.toString();
  return text ? `/inbox?${text}` : "/inbox";
}

function parseRows(data: unknown): InboxRow[] {
  if (!Array.isArray(data)) throw new Error("rows_unreadable");
  return data.map((row: unknown) => {
    const parsed = inboxRowSchema.safeParse(row);
    if (!parsed.success) throw new Error("rows_unreadable");
    return parsed.data;
  });
}

export async function searchInbox(
  supabase: ServerSupabase,
  organizationId: string,
  userId: string,
  filters: InboxFilters,
  page: number,
): Promise<InboxPage> {
  const run = async (limit: number, offset: number): Promise<InboxRow[]> => {
    const { data, error } = await supabase.rpc("search_conversations", {
      p_org: organizationId,
      p_state: filters.state,
      p_channel: filters.channel,
      p_assignee: filters.assignee === "me" ? userId : null,
      p_unassigned: filters.assignee === "none",
      p_query: filters.query,
      p_limit: limit,
      p_offset: offset,
    });
    if (error) throw new Error("inbox_search_failed");
    return parseRows(data);
  };
  const rows = await run(INBOX_PAGE_SIZE, (page - 1) * INBOX_PAGE_SIZE);
  let total = rows[0]?.total_count ?? 0;
  // Page au-delà du total : la fonction ne renvoie aucune ligne donc aucun total ; on le relit (1 ligne) pour garder la navigation.
  if (rows.length === 0 && page > 1) total = (await run(1, 0))[0]?.total_count ?? 0;
  return { rows, total, page, pageSize: INBOX_PAGE_SIZE, pageCount: Math.max(1, Math.ceil(total / INBOX_PAGE_SIZE)) };
}

/** En-tête d'un fil : la conversation avec le nom du contact et le type du canal, ou `null` (inconnue, autre entreprise, hors droits). */
export async function getInboxConversation(supabase: ServerSupabase, organizationId: string, conversationId: string): Promise<InboxRow | null> {
  const { data, error } = await supabase.rpc("search_conversations", { p_org: organizationId, p_limit: 1, p_offset: 0, p_conversation: conversationId });
  if (error) throw new Error("inbox_lookup_failed");
  return parseRows(data)[0] ?? null;
}
