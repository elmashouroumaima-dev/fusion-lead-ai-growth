import {
  membershipRowSchema,
  type OrgStatus,
  type OrganizationSummary,
  type TenantRole,
} from "@fusion-leap/domain";
import { cache } from "react";
import { createClient } from "../supabase/server";
import { getAuthenticatedUserId, type ServerSupabase } from "./identity";
import { TenantError } from "./tenant-error";

/** Adhésion ACTIVE de l'utilisateur, avec son organisation (statut inclus). */
export type ActiveMembership = {
  organizationId: string;
  role: TenantRole;
  organization: OrganizationSummary & { status: OrgStatus };
};

/**
 * Relit en base les adhésions actives de l'utilisateur AVEC SES DROITS (client serveur + RLS).
 * Le filtre `user_id` est explicite : un owner/admin voit toutes les lignes de son entreprise
 * (politique RLS), mais seule SA ligne définit son rôle. Les organisations masquées par la RLS
 * (`organizations` null) sont écartées. Une ligne illisible (dérive de schéma) lève une erreur
 * générique : on ne devine jamais un rôle.
 */
export async function fetchActiveMemberships(
  supabase: ServerSupabase,
  userId: string,
): Promise<ActiveMembership[]> {
  const { data, error } = await supabase
    .from("organization_members")
    .select("organization_id, role, organizations(id, name, slug, locale, timezone, status)")
    .eq("user_id", userId)
    .eq("status", "active");
  if (error) throw new Error("membership_lookup_failed");

  const rows: unknown = data;
  if (!Array.isArray(rows)) throw new Error("membership_lookup_failed");

  const out: ActiveMembership[] = [];
  for (const row of rows) {
    const parsed = membershipRowSchema.safeParse(row);
    if (!parsed.success) throw new Error("membership_lookup_failed");
    const { organization_id, role, organizations } = parsed.data;
    if (!organizations) continue;
    // Cohérence : l'organisation imbriquée doit être celle de la ligne d'adhésion.
    if (organizations.id !== organization_id) throw new Error("membership_lookup_failed");
    out.push({ organizationId: organization_id, role, organization: organizations });
  }
  return out.sort((a, b) => a.organization.name.localeCompare(b.organization.name));
}

/**
 * Identité + adhésions actives de la requête en cours, lues UNE fois par requête (`cache()` de
 * React) et partagées entre layout, page et contexte. Ne PAS s'en servir après une mutation dans
 * la même requête (les actions relisent via `fetchActiveMemberships`).
 * Lève `TenantError('unauthenticated')` sans session valide.
 */
export const loadRequestMemberships = cache(
  async (): Promise<{ userId: string; memberships: ActiveMembership[] }> => {
    const supabase = await createClient();
    const userId = await getAuthenticatedUserId(supabase);
    if (!userId) throw new TenantError("unauthenticated");
    return { userId, memberships: await fetchActiveMemberships(supabase, userId) };
  },
);

/** Adhésions actives de l'utilisateur courant (pages de sélection, sélecteur d'en-tête). */
export async function listMyMemberships(): Promise<ActiveMembership[]> {
  return (await loadRequestMemberships()).memberships;
}
