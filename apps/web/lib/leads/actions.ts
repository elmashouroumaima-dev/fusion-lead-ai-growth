"use server";

import { revalidatePath } from "next/cache";
import { uiLocaleOf } from "../service/form";
import { withAction, type ActionFailure } from "../service/with-service";
import { toActionCode } from "./action-code";
import {
  DEAL_CREATE_FIELDS,
  DEAL_STAGE_FIELDS,
  LEAD_ASSIGN_FIELDS,
  LEAD_STAGE_FIELDS,
  assignLeadFormSchema,
  createDealFormSchema,
  moveDealStageFormSchema,
  moveLeadStageFormSchema,
} from "./action-schemas";
import { assignLead, createDeal, moveDealStage, moveLeadStage } from "./service";
import type { LeadsActionState } from "./types";

/*
 * Server Actions de la fiche lead (J30d : étape du lead, assignation, création et déplacement d'un deal), branchées sur la couche
 * service (`withAction` : zod, contexte tenant relu en base, comparaison de l'organization_id posté, can() de la matrice ADR 014,
 * limitation de débit, idempotence) puis sur les services J19 (fonctions SQL : rôle et propriété du lead relus par la base, projet
 * archivé, abonnement, audit sans valeur de deal ni identité). L'entreprise vient du CONTEXTE, jamais du formulaire.
 *
 * Le commercial n'agit que sur SES leads : la cellule de la matrice est « own » (accordée ici), la base refuse tout autre lead.
 * L'assignation manuelle est réservée à owner et admin (ligne « Leads non assignés : assigner »).
 */

const failure = ({ code, fieldErrors }: ActionFailure): LeadsActionState =>
  fieldErrors ? { status: "error", code: toActionCode(code), fieldErrors } : { status: "error", code: toActionCode(code) };
const loginPath = (formData: FormData): string => `/${uiLocaleOf(formData)}/login`;
const own = () => ({ isOwnRecord: true });

function refresh(uiLocale: string): void {
  revalidatePath(`/${uiLocale}/leads/[id]`, "page");
  revalidatePath(`/${uiLocale}/leads`, "page");
  revalidatePath(`/${uiLocale}/deals`, "page");
}

const moveLeadStageAct = withAction(
  {
    name: "leads.stage.move",
    auth: "tenant",
    schema: moveLeadStageFormSchema,
    fields: LEAD_STAGE_FIELDS,
    permission: { action: "change_stage", resource: "leads", ctx: own },
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    failure,
    loginPath,
  },
  async (ctx, input): Promise<LeadsActionState> => {
    const result = await moveLeadStage(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) return failure({ code: result.code });
    refresh(uiLocaleOf(ctx.formData));
    return { status: "success", success: "leadMoved" };
  },
);

/** Change l'étape d'un lead (dans son pipeline). Clé d'idempotence obligatoire (champ caché). */
export async function moveLeadStageAction(prev: LeadsActionState, formData: FormData): Promise<LeadsActionState> {
  return moveLeadStageAct(prev, formData);
}

const assignLeadAct = withAction(
  {
    name: "leads.assign",
    auth: "tenant",
    schema: assignLeadFormSchema,
    fields: LEAD_ASSIGN_FIELDS,
    permission: { action: "assign", resource: "unassigned_leads" },
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    failure,
    loginPath,
  },
  async (ctx, input): Promise<LeadsActionState> => {
    const result = await assignLead(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) return failure({ code: result.code });
    refresh(uiLocaleOf(ctx.formData));
    return { status: "success", success: input.assignee_id === null ? "unassigned" : "assigned" };
  },
);

/** Assigne un lead à un membre assignable, ou retire son responsable (owner et admin). */
export async function assignLeadAction(prev: LeadsActionState, formData: FormData): Promise<LeadsActionState> {
  return assignLeadAct(prev, formData);
}

const createDealAct = withAction(
  {
    name: "deals.create",
    auth: "tenant",
    schema: createDealFormSchema,
    fields: DEAL_CREATE_FIELDS,
    permission: { action: "update", resource: "deals", ctx: own },
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    failure,
    loginPath,
  },
  async (ctx, input): Promise<LeadsActionState> => {
    const result = await createDeal(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) return failure({ code: result.code });
    refresh(uiLocaleOf(ctx.formData));
    return { status: "success", success: "dealCreated" };
  },
);

/** Crée un deal sur un lead (étape absente : première étape ouverte). Clé d'idempotence obligatoire (champ caché). */
export async function createDealAction(prev: LeadsActionState, formData: FormData): Promise<LeadsActionState> {
  return createDealAct(prev, formData);
}

const moveDealStageAct = withAction(
  {
    name: "deals.stage.move",
    auth: "tenant",
    schema: moveDealStageFormSchema,
    fields: DEAL_STAGE_FIELDS,
    permission: { action: "change_stage", resource: "deals", ctx: own },
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    failure,
    loginPath,
  },
  async (ctx, input): Promise<LeadsActionState> => {
    const result = await moveDealStage(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) return failure({ code: result.code });
    refresh(uiLocaleOf(ctx.formData));
    // La base pose la date « gagné » ou « perdu » selon le genre de l'étape : c'est elle qui décide du message.
    return { status: "success", success: result.value.won_at ? "dealWon" : result.value.lost_at ? "dealLost" : "dealMoved" };
  },
);

/** Déplace un deal vers une étape de son pipeline (les étapes « gagné » et « perdu » posent la date correspondante). */
export async function moveDealStageAction(prev: LeadsActionState, formData: FormData): Promise<LeadsActionState> {
  return moveDealStageAct(prev, formData);
}
