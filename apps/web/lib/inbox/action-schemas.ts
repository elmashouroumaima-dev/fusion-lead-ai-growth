import {
  assignConversationSchema,
  setConversationStateSchema,
  type AssignConversationInput,
  type SetConversationStateInput,
} from "@fusion-leap/domain";
import type { ServiceSchema } from "../service/with-service";

/**
 * Schémas des Server Actions de la boîte de réception : les champs de formulaire (tous des textes) deviennent les entrées des schémas
 * stricts du domaine. L'entreprise n'est JAMAIS postée : elle vient du contexte vérifié (la liste fermée de champs ignore toute valeur envoyée).
 */

type Raw = Record<string, string | undefined>;

type Parsed<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: ReadonlyArray<{ code: string; path: PropertyKey[] }> } };

function through<T>(build: (raw: Raw) => unknown, schema: { safeParse(input: unknown): Parsed<T> }): ServiceSchema<T> {
  return { safeParse: (raw) => schema.safeParse(build(raw as Raw)) };
}

/** Valeur du menu « aucun responsable » : ce n'est jamais un identifiant de membre. */
export const NO_ASSIGNEE = "__none";

export const assignConversationFormSchema: ServiceSchema<AssignConversationInput> = through(
  (r) => ({
    conversation_id: r.conversation_id,
    assignee_id: r.assignee_id === undefined || r.assignee_id === "" || r.assignee_id === NO_ASSIGNEE ? null : r.assignee_id,
  }),
  assignConversationSchema,
);

export const setConversationStateFormSchema: ServiceSchema<SetConversationStateInput> = through(
  (r) => ({ conversation_id: r.conversation_id, state: r.state }),
  setConversationStateSchema,
);

export const INBOX_ASSIGN_FIELDS = ["conversation_id", "assignee_id"] as const;
export const INBOX_STATE_FIELDS = ["conversation_id", "state"] as const;
