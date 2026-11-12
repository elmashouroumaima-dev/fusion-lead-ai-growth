import {
  conversationRowSchema,
  messageRowSchema,
  type AssignConversationInput,
  type ConversationRow,
  type ListConversationsInput,
  type MessageRow,
  type SetConversationStateInput,
} from "@fusion-leap/domain";
import { mapLeadsDbError } from "../leads/map-error";
import type { ServiceErrorCode } from "../service/errors";
import type { ServerSupabase } from "../tenant/identity";

/**
 * Conversations et messages (J30, ADR 007 et 014) : lecture et services d'assignation et d'état. Tout passe par le client serveur de
 * l'UTILISATEUR : la RLS ne livre que ce que son rôle permet (owner et admin tout, le commercial SES conversations, marketing et
 * analyste rien) et les fonctions SQL revérifient le rôle ; aucune `service_role` ici (la réception et l'envoi passent par le worker et
 * les fonctions réservées à ce rôle). L'entreprise vient du CONTEXTE VÉRIFIÉ, jamais du corps. Le CORPS d'un message n'est lu que par
 * `listMessages` et n'est jamais journalisé.
 */
export type ConversationsResult<T> = { ok: true; value: T } | { ok: false; code: ServiceErrorCode };
const fail = (code: ServiceErrorCode): { ok: false; code: ServiceErrorCode } => ({ ok: false, code });

export const CONVERSATIONS_PAGE_SIZE = 25;
export const MESSAGES_PAGE_SIZE = 50;

const CONVERSATION_COLUMNS = "id, organization_id, contact_id, channel_id, assignee_id, state, handled_by, last_message_at, created_at, updated_at";
const MESSAGE_COLUMNS = "id, organization_id, conversation_id, channel_id, direction, body, status, sent_at, received_at, error_code, created_at";

export type ConversationPage = { rows: ConversationRow[]; page: number; pageSize: number };

/** Une page de conversations, la plus récemment active d'abord (celles sans message en dernier). */
export async function listConversations(supabase: ServerSupabase, organizationId: string, input: ListConversationsInput): Promise<ConversationPage> {
  const from = (input.page - 1) * CONVERSATIONS_PAGE_SIZE;
  let query = supabase.from("conversations").select(CONVERSATION_COLUMNS).eq("organization_id", organizationId);
  if (input.state) query = query.eq("state", input.state);
  if (input.assignee_id) query = query.eq("assignee_id", input.assignee_id);
  if (input.unassigned) query = query.is("assignee_id", null);
  const { data, error } = await query
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .order("id", { ascending: true })
    .range(from, from + CONVERSATIONS_PAGE_SIZE - 1);
  if (error || !Array.isArray(data)) throw new Error("conversations_lookup_failed");
  const rows = data.map((row: unknown) => {
    const parsed = conversationRowSchema.safeParse(row);
    if (!parsed.success) throw new Error("rows_unreadable");
    return parsed.data;
  });
  return { rows, page: input.page, pageSize: CONVERSATIONS_PAGE_SIZE };
}

/** Une conversation visible pour l'utilisateur, ou `null` (inconnue, d'une autre entreprise ou hors de ses droits : indiscernables). */
export async function getConversation(supabase: ServerSupabase, organizationId: string, conversationId: string): Promise<ConversationRow | null> {
  const { data, error } = await supabase
    .from("conversations")
    .select(CONVERSATION_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("id", conversationId)
    .maybeSingle();
  if (error) throw new Error("conversation_lookup_failed");
  if (data === null || data === undefined) return null;
  const parsed = conversationRowSchema.safeParse(data);
  if (!parsed.success) throw new Error("rows_unreadable");
  return parsed.data;
}

/** Les messages d'une conversation, du plus récent au plus ancien, 50 par page. La RLS décide ; une conversation interdite renvoie une page vide. */
export async function listMessages(supabase: ServerSupabase, organizationId: string, conversationId: string, page = 1): Promise<MessageRow[]> {
  const from = (page - 1) * MESSAGES_PAGE_SIZE;
  const { data, error } = await supabase
    .from("messages")
    .select(MESSAGE_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(from, from + MESSAGES_PAGE_SIZE - 1);
  if (error || !Array.isArray(data)) throw new Error("messages_lookup_failed");
  return data.map((row: unknown) => {
    const parsed = messageRowSchema.safeParse(row);
    if (!parsed.success) throw new Error("rows_unreadable");
    return parsed.data;
  });
}

/** Assigner (owner et admin) : le responsable doit être un membre assignable ; `null` désassigne et remet la conversation en file de tri. */
export async function assignConversation(supabase: ServerSupabase, organizationId: string, input: AssignConversationInput): Promise<ConversationsResult<true>> {
  const { error } = await supabase.rpc("assign_conversation", { p_org: organizationId, p_id: input.conversation_id, p_assignee: input.assignee_id });
  return error ? fail(mapLeadsDbError(error)) : { ok: true, value: true };
}

/** Changer l'état : owner et admin sur toute conversation, commercial sur les siennes. */
export async function setConversationState(supabase: ServerSupabase, organizationId: string, input: SetConversationStateInput): Promise<ConversationsResult<true>> {
  const { error } = await supabase.rpc("set_conversation_state", { p_org: organizationId, p_id: input.conversation_id, p_state: input.state });
  return error ? fail(mapLeadsDbError(error)) : { ok: true, value: true };
}
