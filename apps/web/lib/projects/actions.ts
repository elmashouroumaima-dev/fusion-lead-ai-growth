"use server";

import { revalidatePath } from "next/cache";
import { uiLocaleOf } from "../service/form";
import { redirectTo, withAction, type ActionFailure } from "../service/with-service";
import { toActionCode } from "./action-code";
import {
  createProductFormSchema,
  createProjectFormSchema,
  PRODUCT_CREATE_FIELDS,
  PRODUCT_UPDATE_FIELDS,
  PROJECT_FORM_FIELDS,
  PROJECT_STATUS_FIELDS,
  PROJECT_UPDATE_FIELDS,
  setProjectStatusFormSchema,
  updateProductFormSchema,
  updateProjectFormSchema,
} from "./action-schemas";
import { createProduct, createProject, setProjectStatus, updateProduct, updateProject } from "./service";
import type { ProjectsActionState } from "./types";

/*
 * Server Actions de l'écran Projets (J17), branchées sur la couche service (`withAction` : zod, contexte tenant relu en
 * base, comparaison de l'organization_id posté, can() de la matrice ADR 014, limitation de débit, idempotence) puis sur
 * les services J16 (fonctions SQL : rôle, quota, audit). Principes : l'entreprise vient du CONTEXTE, jamais du formulaire ;
 * on ne renvoie que des codes ; le créateur d'un projet en est le propriétaire par défaut.
 */

const failure = ({ code, fieldErrors }: ActionFailure): ProjectsActionState =>
  fieldErrors ? { status: "error", code: toActionCode(code), fieldErrors } : { status: "error", code: toActionCode(code) };
const loginPath = (formData: FormData): string => `/${uiLocaleOf(formData)}/login`;

const createProjectAct = withAction(
  {
    name: "projects.create",
    auth: "tenant",
    schema: createProjectFormSchema,
    fields: PROJECT_FORM_FIELDS,
    permission: { action: "create", resource: "projects" },
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    failure,
    loginPath,
  },
  async (ctx, input): Promise<ProjectsActionState | ReturnType<typeof redirectTo>> => {
    const result = await createProject(ctx.supabase, ctx.organizationId, { ...input, owner_id: ctx.userId });
    if (!result.ok) return failure({ code: result.code });
    const uiLocale = uiLocaleOf(ctx.formData);
    revalidatePath(`/${uiLocale}/projects`);
    return redirectTo(`/${uiLocale}/projects/${result.value.id}?created=1`);
  },
);

/** Crée un projet (le créateur en est le propriétaire) puis ouvre sa page. Clé d'idempotence obligatoire (champ caché). */
export async function createProjectAction(prev: ProjectsActionState, formData: FormData): Promise<ProjectsActionState> {
  return createProjectAct(prev, formData);
}

const updateProjectAct = withAction(
  {
    name: "projects.update",
    auth: "tenant",
    schema: updateProjectFormSchema,
    fields: PROJECT_UPDATE_FIELDS,
    permission: { action: "update", resource: "projects" },
    rateLimit: "mutation",
    idempotency: { mode: "optional", storeResponse: true },
    failure,
    loginPath,
  },
  async (ctx, input): Promise<ProjectsActionState> => {
    const result = await updateProject(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) return failure({ code: result.code });
    const uiLocale = uiLocaleOf(ctx.formData);
    revalidatePath(`/${uiLocale}/projects`);
    revalidatePath(`/${uiLocale}/projects/${input.project_id}`);
    return { status: "success", success: "updated" };
  },
);

/** Modifie le nom et les réglages d'un projet (le type est immuable ; le propriétaire est conservé). */
export async function updateProjectAction(prev: ProjectsActionState, formData: FormData): Promise<ProjectsActionState> {
  return updateProjectAct(prev, formData);
}

const setStatusAct = withAction(
  {
    name: "projects.set_status",
    auth: "tenant",
    schema: setProjectStatusFormSchema,
    fields: PROJECT_STATUS_FIELDS,
    permission: { action: "archive", resource: "projects" },
    rateLimit: "mutation",
    idempotency: { mode: "optional", storeResponse: true },
    failure,
    loginPath,
  },
  async (ctx, input): Promise<ProjectsActionState> => {
    const result = await setProjectStatus(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) return failure({ code: result.code });
    const uiLocale = uiLocaleOf(ctx.formData);
    revalidatePath(`/${uiLocale}/projects`);
    revalidatePath(`/${uiLocale}/projects/${input.project_id}`);
    return { status: "success", success: input.status === "archived" ? "archived" : "reactivated" };
  },
);

/** Archive ou réactive un projet (la réactivation consomme de nouveau le quota du plan). */
export async function setProjectStatusAction(prev: ProjectsActionState, formData: FormData): Promise<ProjectsActionState> {
  return setStatusAct(prev, formData);
}

const createProductAct = withAction(
  {
    name: "products.create",
    auth: "tenant",
    schema: createProductFormSchema,
    fields: PRODUCT_CREATE_FIELDS,
    permission: { action: "create", resource: "projects" },
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    failure,
    loginPath,
  },
  async (ctx, input): Promise<ProjectsActionState> => {
    const result = await createProduct(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) return failure({ code: result.code });
    const uiLocale = uiLocaleOf(ctx.formData);
    revalidatePath(`/${uiLocale}/projects/${input.project_id}`);
    return { status: "success", success: "productCreated" };
  },
);

/** Ajoute un produit à un projet actif. Clé d'idempotence obligatoire (champ caché). */
export async function createProductAction(prev: ProjectsActionState, formData: FormData): Promise<ProjectsActionState> {
  return createProductAct(prev, formData);
}

const updateProductAct = withAction(
  {
    name: "products.update",
    auth: "tenant",
    schema: updateProductFormSchema,
    fields: PRODUCT_UPDATE_FIELDS,
    permission: { action: "update", resource: "projects" },
    rateLimit: "mutation",
    idempotency: { mode: "optional", storeResponse: true },
    failure,
    loginPath,
  },
  async (ctx, input): Promise<ProjectsActionState> => {
    const result = await updateProduct(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) return failure({ code: result.code });
    const uiLocale = uiLocaleOf(ctx.formData);
    revalidatePath(`/${uiLocale}/projects/${result.value.project_id}`);
    return { status: "success", success: "productUpdated" };
  },
);

/** Modifie un produit d'un projet actif (les fichiers déjà associés sont conservés tels quels). */
export async function updateProductAction(prev: ProjectsActionState, formData: FormData): Promise<ProjectsActionState> {
  return updateProductAct(prev, formData);
}
