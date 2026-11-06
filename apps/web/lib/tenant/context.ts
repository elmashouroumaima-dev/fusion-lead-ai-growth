import { localeSchema, type AuthLocale, type TenantRole } from "@fusion-leap/domain";
import { redirect } from "next/navigation";
import { DEFAULT_LOCALE } from "../auth/routes";
import { readActiveOrgCookie } from "./active-org-cookie";
import { loadRequestMemberships } from "./memberships";
import { resolveActiveMembership } from "./resolve";
import { TenantError } from "./tenant-error";

export { TenantError } from "./tenant-error";
export type { TenantErrorCode } from "./tenant-error";

export type TenantContext = {
  userId: string;
  organizationId: string;
  role: TenantRole;
  organization: { id: string; name: string; slug: string; locale: AuthLocale; timezone: string };
};

/**
 * Contexte tenant de la requête (ADR 005 §7). Revérifié à chaque REQUÊTE (mémoïsation `cache()` de React limitée à la requête, jamais entre requêtes) :
 *  1. identité = claims d'un JWT vérifié (`getClaims()`) ;
 *  2. adhésions ACTIVES relues en base avec les droits de l'utilisateur (RLS) ;
 *  3. le cookie `fl_active_org` n'est qu'un indice, confronté à ces adhésions ;
 *  4. le rôle vient de `organization_members.role`, jamais du JWT ni de `user_metadata`.
 * Lève `TenantError`. Aucune `service_role` n'est utilisée.
 */
export async function getTenantContext(): Promise<TenantContext> {
  const { userId, memberships } = await loadRequestMemberships();
  const hint = await readActiveOrgCookie();
  const active = resolveActiveMembership(memberships, hint);

  return {
    userId,
    organizationId: active.organizationId,
    role: active.role,
    organization: {
      id: active.organization.id,
      name: active.organization.name,
      slug: active.organization.slug,
      locale: active.organization.locale,
      timezone: active.organization.timezone,
    },
  };
}

/**
 * Variante pour pages et layouts : redirige (locale-aware) au lieu de lever.
 *  - non authentifié                      -> /{locale}/login
 *  - aucune organisation                  -> /{locale}/onboarding
 *  - choix requis / cookie sans adhésion / organisation inactive -> /{locale}/select-organization
 * Un Server Component ne peut pas effacer le cookie : on ne le tente pas. `redirect()` lève
 * NEXT_REDIRECT, d'où l'appel hors du try/catch. Toute autre erreur est propagée (page d'erreur).
 */
export async function requireTenantContext(locale: string): Promise<TenantContext> {
  const parsed = localeSchema.safeParse(locale);
  const safeLocale = parsed.success ? parsed.data : DEFAULT_LOCALE;

  let failure: TenantError;
  try {
    return await getTenantContext();
  } catch (error) {
    if (!(error instanceof TenantError)) throw error;
    failure = error;
  }

  switch (failure.code) {
    case "unauthenticated":
      return redirect(`/${safeLocale}/login`);
    case "no_organization":
      return redirect(`/${safeLocale}/onboarding`);
    case "organization_selection_required":
    case "forbidden":
    case "organization_inactive":
      return redirect(`/${safeLocale}/select-organization`);
  }
}

/**
 * Un `organization_id` fourni par le client (corps, URL, formulaire) doit être identique à celui
 * du contexte vérifié, sinon `forbidden`. `undefined` = rien de revendiqué ; toute autre valeur
 * (null, nombre, objet, autre uuid) est refusée. Comparaison insensible à la casse.
 */
export function assertSameOrganization(ctx: TenantContext, claimedId: unknown): void {
  if (claimedId === undefined) return;
  if (typeof claimedId !== "string" || claimedId.toLowerCase() !== ctx.organizationId.toLowerCase()) {
    throw new TenantError("forbidden");
  }
}
