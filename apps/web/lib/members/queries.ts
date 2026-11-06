import { invitationRowSchema, memberRowSchema, type InvitationRow, type MemberRow } from "@fusion-leap/domain";
import { createClient } from "../supabase/server";
import type { TenantContext } from "../tenant/context";

/**
 * Lectures de la page Membres, faites avec les droits de l'utilisateur (client serveur + RLS ; aucune
 * `service_role`). Le filtre `organization_id` est explicite (défense en profondeur : la RLS reste
 * l'autorité). Toute ligne illisible lève une erreur générique : on ne devine jamais un rôle.
 *
 * Limite connue : les e-mails des membres vivent dans `auth.users`, illisible sans `service_role`.
 * Les membres sont donc identifiés par un identifiant court opaque + rôle + statut ; les invitations,
 * elles, portent l'e-mail (visible pour owner/admin). Un profil (nom affichable) viendra avec une table dédiée.
 */
export async function listOrganizationMembers(ctx: TenantContext): Promise<MemberRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organization_members")
    .select("id, user_id, role, status, created_at")
    .eq("organization_id", ctx.organizationId)
    .neq("status", "removed")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw new Error("members_lookup_failed");
  return parseRows(data, memberRowSchema);
}

/** Invitations en attente : ni acceptées ni révoquées (une invitation expirée mais non révoquée reste listée). */
export async function listPendingInvitations(ctx: TenantContext): Promise<InvitationRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("invitations")
    .select("id, email_normalized, role, expires_at, created_at")
    .eq("organization_id", ctx.organizationId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true });
  if (error) throw new Error("invitations_lookup_failed");
  return parseRows(data, invitationRowSchema);
}

type RowParser<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };

function parseRows<T>(data: unknown, schema: RowParser<T>): T[] {
  if (!Array.isArray(data)) throw new Error("rows_unreadable");
  return data.map((row: unknown) => {
    const parsed = schema.safeParse(row);
    if (!parsed.success) throw new Error("rows_unreadable");
    return parsed.data;
  });
}
