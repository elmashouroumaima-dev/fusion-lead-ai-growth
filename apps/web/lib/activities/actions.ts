"use server";

import { revalidatePath } from "next/cache";
import { uiLocaleOf } from "../service/form";
import { withAction, type ActionFailure } from "../service/with-service";
import { toActionCode } from "./action-code";
import { ACTIVITY_CREATE_FIELDS, TASK_COMPLETE_FIELDS, completeTaskFormSchema, createActivityFormSchema } from "./action-schemas";
import { completeTask, createActivity } from "./service";
import type { ActivitiesActionState } from "./types";

/*
 * Server Actions de la fiche lead (J30c), branchées sur la couche service (`withAction` : zod, contexte tenant relu en base,
 * comparaison de l'organization_id posté, can() de la matrice ADR 014 « Leads / deals : tâches », limitation de débit,
 * idempotence) puis sur les services J20 (fonctions SQL : rôle et propriété du lead relus par la base, projet archivé, abonnement,
 * audit sans contenu). L'entreprise vient du CONTEXTE, jamais du formulaire ; on ne renvoie que des codes.
 *
 * Le commercial n'agit que sur SES leads : la cellule de la matrice est « own » (accordée ici), la base refuse tout autre lead.
 */

const failure = ({ code, fieldErrors }: ActionFailure): ActivitiesActionState =>
  fieldErrors ? { status: "error", code: toActionCode(code), fieldErrors } : { status: "error", code: toActionCode(code) };
const loginPath = (formData: FormData): string => `/${uiLocaleOf(formData)}/login`;

const SUCCESS = { note: "noteAdded", call: "callAdded", task: "taskAdded" } as const;

const createActivityAct = withAction(
  {
    name: "activities.create",
    auth: "tenant",
    schema: createActivityFormSchema,
    fields: ACTIVITY_CREATE_FIELDS,
    permission: { action: "manage_tasks", resource: "leads", ctx: () => ({ isOwnRecord: true }) },
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    failure,
    loginPath,
  },
  async (ctx, input): Promise<ActivitiesActionState> => {
    const result = await createActivity(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) return failure({ code: result.code });
    revalidatePath(`/${uiLocaleOf(ctx.formData)}/leads/[id]`, "page");
    const success = input.type === "note" || input.type === "call" || input.type === "task" ? SUCCESS[input.type] : "noteAdded";
    return { status: "success", success };
  },
);

/** Ajoute une note, un appel ou une tâche à un lead. Clé d'idempotence obligatoire (champ caché). */
export async function createActivityAction(prev: ActivitiesActionState, formData: FormData): Promise<ActivitiesActionState> {
  return createActivityAct(prev, formData);
}

const completeTaskAct = withAction(
  {
    name: "activities.task.complete",
    auth: "tenant",
    schema: completeTaskFormSchema,
    fields: TASK_COMPLETE_FIELDS,
    permission: { action: "manage_tasks", resource: "leads", ctx: () => ({ isOwnRecord: true }) },
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    failure,
    loginPath,
  },
  async (ctx, input): Promise<ActivitiesActionState> => {
    const result = await completeTask(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) return failure({ code: result.code });
    revalidatePath(`/${uiLocaleOf(ctx.formData)}/leads/[id]`, "page");
    return { status: "success", success: input.done ? "taskDone" : "taskReopened" };
  },
);

/** Marque une tâche faite ou à refaire (la date de fin est posée par la base). */
export async function completeTaskAction(prev: ActivitiesActionState, formData: FormData): Promise<ActivitiesActionState> {
  return completeTaskAct(prev, formData);
}
