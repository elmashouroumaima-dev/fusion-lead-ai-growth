import { z } from "zod";
import { uuidSchema } from "../tenant/schemas";

/**
 * Conversations et messages (J30, spec §7 et §9.3, ADR 007 et 014). Les schémas d'entrée sont stricts et refusent un `organization_id`
 * (l'entreprise vient du contexte vérifié). Le CORPS d'un message n'est jamais journalisé ni audité.
 */
export const CONVERSATION_STATES = ["open", "pending", "closed", "to_triage"] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

export const CONVERSATION_HANDLERS = ["human", "ai_suggest"] as const;
export const MESSAGE_DIRECTIONS = ["inbound", "outbound"] as const;
/** Statuts de l'ADR 007 plus `received`, réservé aux messages ENTRANTS. */
export const MESSAGE_STATUSES = ["queued", "accepted", "sent", "delivered", "read", "failed", "bounced", "cancelled", "received"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** Corps d'un message : 1 à 100 000 caractères. */
export const MESSAGE_BODY_MAX = 100_000;

/**
 * Un état est cohérent avec la présence d'un responsable : `to_triage` (file de tri) n'existe que sans responsable, `open` exige un
 * responsable. Mêmes règles que `set_conversation_state` en base (la base reste l'autorité).
 */
export function isStateAllowed(state: ConversationState, hasAssignee: boolean): boolean {
  if (state === "to_triage") return !hasAssignee;
  if (state === "open") return hasAssignee;
  return true;
}

export const assignConversationSchema = z.object({ conversation_id: uuidSchema, assignee_id: uuidSchema.nullable() }).strict();
export type AssignConversationInput = z.infer<typeof assignConversationSchema>;

export const setConversationStateSchema = z.object({ conversation_id: uuidSchema, state: z.enum(CONVERSATION_STATES) }).strict();
export type SetConversationStateInput = z.infer<typeof setConversationStateSchema>;

export const listConversationsSchema = z
  .object({
    state: z.enum(CONVERSATION_STATES).optional(),
    assignee_id: uuidSchema.optional(),
    unassigned: z.boolean().optional(),
    page: z.number().int().min(1).max(10_000).default(1),
  })
  .strict();
export type ListConversationsInput = z.infer<typeof listConversationsSchema>;

export const conversationRowSchema = z.object({
  id: uuidSchema,
  organization_id: uuidSchema,
  contact_id: uuidSchema,
  channel_id: uuidSchema,
  assignee_id: uuidSchema.nullable(),
  state: z.enum(CONVERSATION_STATES),
  handled_by: z.enum(CONVERSATION_HANDLERS),
  last_message_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ConversationRow = z.infer<typeof conversationRowSchema>;

export const messageRowSchema = z.object({
  id: uuidSchema,
  organization_id: uuidSchema,
  conversation_id: uuidSchema,
  channel_id: uuidSchema,
  direction: z.enum(MESSAGE_DIRECTIONS),
  body: z.string(),
  status: z.enum(MESSAGE_STATUSES),
  sent_at: z.string().nullable(),
  received_at: z.string().nullable(),
  error_code: z.string().nullable(),
  created_at: z.string(),
});
export type MessageRow = z.infer<typeof messageRowSchema>;
