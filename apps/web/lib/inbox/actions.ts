"use server";

import { revalidatePath } from "next/cache";
import { assignConversation, setConversationState } from "../conversations/service";
import { uiLocaleOf } from "../service/form";
import type { ServiceErrorCode } from "../service/errors";
import { withAction, type ActionFailure } from "../service/with-service";
import { INBOX_ASSIGN_FIELDS, INBOX_STATE_FIELDS, assignConversationFormSchema, setConversationStateFormSchema } from "./action-schemas";
import type { InboxActionErrorCode, InboxActionState } from "./types";

/*
 * Server Actions de la boîte de réception (J37) : assigner une conversation (owner et admin) et changer son état (owner et admin sur
 * toute conversation, le commercial sur les siennes), branchées sur la couche service (`withAction` : zod, contexte tenant relu en
 * base, `can()` ADR 014, limitation de débit, idempotence) puis sur les services J30 (fonctions SQL : rôle, responsable assignable,
 * état cohérent avec le responsable, audit sans corps de message). L'entreprise vient du CONTEXTE : le formulaire ne la poste pas et
 * la liste fermée de champs ignorerait toute valeur envoyée.
 */

function toCode(code: ServiceErrorCode): InboxActionErrorCode {
  switch (code) {
    case "validation_failed":
    case "payload_too_large":
      return "invalid_input";
    case "forbidden":
    case "unauthenticated":
      return "forbidden";
    case "conflict":
    case "not_found":
    case "rate_limited":
    case "duplicate_request":
    case "idempotency_in_progress":
    case "idempotency_conflict":
    case "service_unavailable":
      return code;
    default:
      return "generic";
  }
}

const failure = ({ code, fieldErrors }: ActionFailure): InboxActionState =>
  fieldErrors ? { status: "error", code: toCode(code), fieldErrors } : { status: "error", code: toCode(code) };
const loginPath = (formData: FormData): string => `/${uiLocaleOf(formData)}/login`;

function refresh(uiLocale: string): void {
  revalidatePath(`/${uiLocale}/inbox`, "page");
  revalidatePath(`/${uiLocale}/inbox/[id]`, "page");
}

const assignAct = withAction(
  {
    name: "inbox.assign",
    auth: "tenant",
    schema: assignConversationFormSchema,
    fields: INBOX_ASSIGN_FIELDS,
    // Assigner une conversation : owner et admin (ADR 014, comme l'assignation des leads). La base revérifie.
    permission: { action: "assign", resource: "unassigned_leads" },
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    failure,
    loginPath,
  },
  async (ctx, input): Promise<InboxActionState> => {
    const result = await assignConversation(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) return failure({ code: result.code });
    refresh(uiLocaleOf(ctx.formData));
    return { status: "success", success: input.assignee_id === null ? "unassigned" : "assigned" };
  },
);

/** Assigne une conversation à un membre assignable, ou retire son responsable (la file de tri la reprend). */
export async function assignConversationAction(prev: InboxActionState, formData: FormData): Promise<InboxActionState> {
  return assignAct(prev, formData);
}

const stateAct = withAction(
  {
    name: "inbox.state.set",
    auth: "tenant",
    schema: setConversationStateFormSchema,
    fields: INBOX_STATE_FIELDS,
    // Répondre / agir sur une conversation : owner et admin sur toutes, le commercial sur les siennes (la base refuse les autres).
    permission: { action: "reply", resource: "conversations", ctx: () => ({ isOwnRecord: true }) },
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    failure,
    loginPath,
  },
  async (ctx, input): Promise<InboxActionState> => {
    const result = await setConversationState(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) return failure({ code: result.code });
    refresh(uiLocaleOf(ctx.formData));
    return { status: "success", success: "stateChanged" };
  },
);

/** Change l'état d'une conversation (« à trier » seulement sans responsable, « ouverte » seulement avec un responsable). */
export async function setConversationStateAction(prev: InboxActionState, formData: FormData): Promise<InboxActionState> {
  return stateAct(prev, formData);
}
