"use server";

import {
  createOrganizationSchema,
  idempotencyKeySchema,
  localeSchema,
  uuidSchema,
  type AuthLocale,
} from "@fusion-leap/domain";
import { redirect } from "next/navigation";
import type { ApiErrorCode } from "../api/errors";
import { DEFAULT_LOCALE } from "../auth/routes";
import { createClient } from "../supabase/server";
import { setActiveOrgCookie } from "./active-org-cookie";
import { createOrganizationForUser } from "./create-organization";
import { getAuthenticatedUserId } from "./identity";
import { fetchActiveMemberships } from "./memberships";
import type { TenantActionErrorCode, TenantActionState } from "./types";

const fail = (code: TenantActionErrorCode, fieldErrors?: Record<string, string[]>): TenantActionState =>
  fieldErrors ? { status: "error", code, fieldErrors } : { status: "error", code };

/** Lit uniquement les champs attendus ; une valeur absente ou non textuelle donne `undefined`. */
function field(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

/** Erreurs de champ : noms de champs et codes zod uniquement, jamais les valeurs saisies. */
function toFieldErrors(error: { issues: ReadonlyArray<{ code: string; path: PropertyKey[] }> }): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    (out[key] ??= []).push(issue.code);
  }
  return out;
}

/** Locale de l'interface (redirections) : valeur validée, repli sur la locale par défaut. */
function uiLocaleOf(formData: FormData): AuthLocale {
  const parsed = localeSchema.safeParse(field(formData, "uiLocale"));
  return parsed.success ? parsed.data : DEFAULT_LOCALE;
}

function toActionCode(code: ApiErrorCode): TenantActionErrorCode {
  switch (code) {
    case "validation_failed":
      return "invalid_input";
    case "forbidden":
      return "forbidden";
    case "idempotency_conflict":
      return "idempotency_conflict";
    default:
      return "generic";
  }
}

/**
 * Création d'organisation depuis l'onboarding. L'identifiant d'organisation n'est JAMAIS lu du
 * formulaire (le serveur le crée) ; l'identité vient des claims vérifiés. La clé de création
 * (champ caché généré au rendu) rend l'envoi rejouable sans doublon. Succès : cookie d'organisation
 * active posé, puis redirection vers le tableau de bord.
 */
export async function createOrganizationAction(
  _prev: TenantActionState,
  formData: FormData,
): Promise<TenantActionState> {
  const uiLocale = uiLocaleOf(formData);

  const input = createOrganizationSchema.safeParse({
    name: field(formData, "name"),
    locale: field(formData, "locale"),
    timezone: field(formData, "timezone"),
  });
  const key = idempotencyKeySchema.safeParse(field(formData, "creation_key"));
  if (!input.success) return fail("invalid_input", toFieldErrors(input.error));
  if (!key.success) return fail("invalid_input", { creation_key: key.error.issues.map((issue) => issue.code) });

  const supabase = await createClient();
  const userId = await getAuthenticatedUserId(supabase);
  if (!userId) redirect(`/${uiLocale}/login`);

  const result = await createOrganizationForUser(supabase, userId, input.data, key.data);
  if (!result.ok) {
    if (result.code === "unauthenticated") redirect(`/${uiLocale}/login`);
    return fail(toActionCode(result.code));
  }

  await setActiveOrgCookie(result.organization.id);
  // redirect() lève NEXT_REDIRECT : surtout pas dans un try/catch.
  redirect(`/${uiLocale}/dashboard`);
}

/**
 * Changement d'organisation active. Le cookie n'est posé qu'APRÈS avoir relu en base une adhésion
 * active de l'utilisateur dans une organisation active : l'identifiant reçu n'est qu'une demande.
 */
export async function switchOrganizationAction(
  _prev: TenantActionState,
  formData: FormData,
): Promise<TenantActionState> {
  const uiLocale = uiLocaleOf(formData);

  const requested = uuidSchema.safeParse(field(formData, "organization_id"));
  if (!requested.success) return fail("invalid_input", toFieldErrors(requested.error));

  const supabase = await createClient();
  const userId = await getAuthenticatedUserId(supabase);
  if (!userId) redirect(`/${uiLocale}/login`);

  let allowed: boolean;
  try {
    const memberships = await fetchActiveMemberships(supabase, userId);
    allowed = memberships.some((m) => m.organizationId === requested.data && m.organization.status === "active");
  } catch {
    return fail("generic");
  }
  if (!allowed) return fail("forbidden");

  await setActiveOrgCookie(requested.data);
  redirect(`/${uiLocale}/dashboard`);
}
