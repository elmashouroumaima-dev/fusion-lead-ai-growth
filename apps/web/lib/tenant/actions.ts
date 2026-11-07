"use server";

import { createOrganizationSchema, idempotencyKeySchema, uuidSchema, type CreateOrganizationInput } from "@fusion-leap/domain";
import { ServiceError } from "../service/errors";
import { serviceCodeToFormCode, uiLocaleOf } from "../service/form";
import { redirectTo, withAction, type ActionFailure, type ServiceSchema } from "../service/with-service";
import { setActiveOrgCookie } from "./active-org-cookie";
import { createOrganizationForUser } from "./create-organization";
import { fetchActiveMemberships } from "./memberships";
import type { TenantActionErrorCode, TenantActionState } from "./types";

const fail = (code: TenantActionErrorCode, fieldErrors?: Record<string, string[]>): TenantActionState =>
  fieldErrors ? { status: "error", code, fieldErrors } : { status: "error", code };

const loginPath = (formData: FormData): string => `/${uiLocaleOf(formData)}/login`;

const failure = ({ code, fieldErrors }: ActionFailure): TenantActionState => fail(serviceCodeToFormCode(code), fieldErrors);

type CreateOrganizationFormInput = { organization: CreateOrganizationInput; creationKey: string };

/** Nom, locale, fuseau (domain) + clé de création (champ caché généré au rendu), validés ensemble avant l'authentification. */
const createOrganizationFormSchema: ServiceSchema<CreateOrganizationFormInput> = {
  safeParse(raw) {
    const record = (raw ?? {}) as Record<string, unknown>;
    const input = createOrganizationSchema.safeParse({
      name: record.name,
      locale: record.locale,
      timezone: record.timezone,
    });
    const key = idempotencyKeySchema.safeParse(record.creation_key);
    if (!input.success) return { success: false, error: { issues: input.error.issues } };
    if (!key.success) {
      return { success: false, error: { issues: key.error.issues.map((issue) => ({ code: issue.code, path: ["creation_key"] })) } };
    }
    return { success: true, data: { organization: input.data, creationKey: key.data } };
  },
};

const createOrganization = withAction(
  {
    name: "orgs.create",
    auth: "user",
    rateLimit: "sensitive",
    idempotency: "none", // la clé de création du RPC (creation_key) assure déjà l'idempotence
    schema: createOrganizationFormSchema,
    fields: ["name", "locale", "timezone", "creation_key"],
    failure,
    loginPath,
  },
  async (ctx, { organization, creationKey }): Promise<TenantActionState | ReturnType<typeof redirectTo>> => {
    const result = await createOrganizationForUser(ctx.supabase, ctx.userId, organization, creationKey);
    if (!result.ok) throw new ServiceError(result.code);

    await setActiveOrgCookie(result.organization.id);
    return redirectTo(`/${uiLocaleOf(ctx.formData)}/dashboard`);
  },
);

/**
 * Création d'organisation depuis l'onboarding. L'identifiant d'organisation n'est JAMAIS lu du
 * formulaire (le serveur le crée) ; l'identité vient des claims vérifiés. La clé de création
 * (champ caché généré au rendu) rend l'envoi rejouable sans doublon. Succès : cookie d'organisation
 * active posé, puis redirection vers le tableau de bord.
 */
export async function createOrganizationAction(prev: TenantActionState, formData: FormData): Promise<TenantActionState> {
  return createOrganization(prev, formData);
}

const switchOrganization = withAction(
  {
    name: "orgs.switch",
    auth: "user",
    rateLimit: "mutation",
    idempotency: "none",
    schema: {
      safeParse(raw) {
        const requested = uuidSchema.safeParse((raw as Record<string, unknown>).organization_id);
        return requested.success ? { success: true, data: requested.data } : { success: false, error: { issues: requested.error.issues } };
      },
    } satisfies ServiceSchema<string>,
    fields: ["organization_id"],
    failure,
    loginPath,
  },
  async (ctx, requested): Promise<TenantActionState | ReturnType<typeof redirectTo>> => {
    let allowed: boolean;
    try {
      const memberships = await fetchActiveMemberships(ctx.supabase, ctx.userId);
      allowed = memberships.some((m) => m.organizationId === requested && m.organization.status === "active");
    } catch {
      return fail("generic");
    }
    if (!allowed) return fail("forbidden");

    await setActiveOrgCookie(requested);
    return redirectTo(`/${uiLocaleOf(ctx.formData)}/dashboard`);
  },
);

/**
 * Changement d'organisation active. Le cookie n'est posé qu'APRÈS avoir relu en base une adhésion
 * active de l'utilisateur dans une organisation active : l'identifiant reçu n'est qu'une demande.
 */
export async function switchOrganizationAction(prev: TenantActionState, formData: FormData): Promise<TenantActionState> {
  return switchOrganization(prev, formData);
}
