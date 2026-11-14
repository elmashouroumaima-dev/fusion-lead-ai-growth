"use server";

import { revalidatePath } from "next/cache";
import { acquireConversationLock, releaseConversationLock, takeOverConversation } from "../conversations/service";
import { uiLocaleOf } from "../service/form";
import type { ServiceErrorCode } from "../service/errors";
import { withAction, type ActionFailure } from "../service/with-service";
import { INBOX_LOCK_FIELDS, lockFormSchema } from "./action-schemas";
import type { InboxActionErrorCode, LockActionState } from "./types";

/*
 * Verrou humain / IA d'une conversation (J38) : prendre ou renouveler le bail de 5 minutes (appelé au focus du composeur puis toutes les
 * 2 minutes), le libérer, ou reprendre la main sur l'IA. Rôles comme pour répondre (owner et admin partout, commercial sur ses
 * conversations : la base revérifie). Un bail est naturellement rejouable (renouvellement) : pas de clé d'idempotence. L'entreprise
 * vient du contexte vérifié, jamais du formulaire.
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
    case "service_unavailable":
      return code;
    default:
      return "generic";
  }
}

const failure = ({ code }: ActionFailure): LockActionState => ({ status: "error", code: toCode(code) });
const loginPath = (formData: FormData): string => `/${uiLocaleOf(formData)}/login`;
const permission = { action: "reply", resource: "conversations", ctx: () => ({ isOwnRecord: true }) } as const;

const acquireAct = withAction(
  { name: "inbox.lock.acquire", auth: "tenant", schema: lockFormSchema, fields: INBOX_LOCK_FIELDS, permission, rateLimit: "mutation", idempotency: "none", failure, loginPath },
  async (ctx, input): Promise<LockActionState> => {
    const result = await acquireConversationLock(ctx.supabase, ctx.organizationId, input.conversation_id);
    if (!result.ok) return failure({ code: result.code });
    const { status, expires_at } = result.value;
    if (status === "acquired") return expires_at ? { status: "success", lock: "mine", expiresAt: expires_at } : { status: "success", lock: "mine" };
    return { status: "success", lock: status === "ai" ? "ai" : "other" };
  },
);
export async function acquireLockAction(prev: LockActionState, formData: FormData): Promise<LockActionState> {
  return acquireAct(prev, formData);
}

const releaseAct = withAction(
  { name: "inbox.lock.release", auth: "tenant", schema: lockFormSchema, fields: INBOX_LOCK_FIELDS, permission, rateLimit: "mutation", idempotency: "none", failure, loginPath },
  async (ctx, input): Promise<LockActionState> => {
    const result = await releaseConversationLock(ctx.supabase, ctx.organizationId, input.conversation_id);
    return result.ok ? { status: "success", lock: "released" } : failure({ code: result.code });
  },
);
export async function releaseLockAction(prev: LockActionState, formData: FormData): Promise<LockActionState> {
  return releaseAct(prev, formData);
}

const takeOverAct = withAction(
  { name: "inbox.lock.take_over", auth: "tenant", schema: lockFormSchema, fields: INBOX_LOCK_FIELDS, permission, rateLimit: "mutation", idempotency: "none", failure, loginPath },
  async (ctx, input): Promise<LockActionState> => {
    const result = await takeOverConversation(ctx.supabase, ctx.organizationId, input.conversation_id);
    if (!result.ok) return failure({ code: result.code });
    revalidatePath(`/${uiLocaleOf(ctx.formData)}/inbox/[id]`, "page");
    return { status: "success", lock: "taken_over" };
  },
);
export async function takeOverAction(prev: LockActionState, formData: FormData): Promise<LockActionState> {
  return takeOverAct(prev, formData);
}
