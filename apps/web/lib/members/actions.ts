"use server";

import {
  changeRoleSchema,
  inviteMemberSchema,
  invitationTokenSchema,
  memberRowSchema,
  removeMemberSchema,
  revokeInvitationSchema,
  tenantRoleSchema,
  transferOwnershipSchema,
  uuidSchema,
  type AuthLocale,
  type MemberRow,
  type TenantRole,
} from "@fusion-leap/domain";
import { can, canManageMember } from "@fusion-leap/permissions";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "../supabase/server";
import { setActiveOrgCookie } from "../tenant/active-org-cookie";
import { assertSameOrganization, getTenantContext, TenantError, type TenantContext } from "../tenant/context";
import { getAuthenticatedUserId, type ServerSupabase } from "../tenant/identity";
import { fail, field, toFieldErrors, uiLocaleOf } from "./form";
import { mapMembersDbError } from "./map-error";
import { generateInvitationToken, hashInvitationToken } from "./token";
import type { MembersActionState } from "./types";

/*
 * Server Actions de la page Membres (J10). Principes, communs à toutes :
 *  - zod d'abord ; l'identifiant d'organisation n'est JAMAIS lu du formulaire comme vérité : le
 *    contexte (adhésion relue en base) décide, et un `organization_id` posté doit lui être identique ;
 *  - `can()` / `canManageMember()` AVANT la base (défense en profondeur) ; la RLS et les fonctions
 *    SQL restent l'autorité finale ;
 *  - le rôle de la cible vient de la base, jamais du formulaire ;
 *  - on ne renvoie que des codes ; jamais de jeton, d'e-mail ou d'empreinte dans un journal.
 *
 * Réservé J11/J12 (volontairement non construit, listé au rapport) : écriture dans audit_logs (invitation créée /
 * révoquée / acceptée, rôle changé, membre retiré, propriété transférée) et passage par la couche de
 * service avec table d'idempotence (Idempotency-Key). Les points d'insertion sont marqués « AUDIT ».
 */

type Authorized = { ok: true; ctx: TenantContext; supabase: ServerSupabase; uiLocale: AuthLocale };
type Denied = { ok: false; state: MembersActionState };

/**
 * Contexte tenant revérifié (adhésion active relue en base) + comparaison de l'organisation revendiquée.
 * `redirect()` lève NEXT_REDIRECT : l'appel est donc fait hors du try/catch.
 */
async function authorize(formData: FormData, claimedOrganizationId: string | undefined): Promise<Authorized | Denied> {
  const uiLocale = uiLocaleOf(formData);

  let ctx: TenantContext | undefined;
  let failure: TenantError | undefined;
  try {
    ctx = await getTenantContext();
  } catch (error) {
    if (!(error instanceof TenantError)) return { ok: false, state: fail("generic") };
    failure = error;
  }
  if (!ctx) {
    if (failure?.code === "unauthenticated") redirect(`/${uiLocale}/login`);
    return { ok: false, state: fail("forbidden") };
  }

  try {
    assertSameOrganization(ctx, claimedOrganizationId);
  } catch {
    return { ok: false, state: fail("forbidden") };
  }
  return { ok: true, ctx, supabase: await createClient(), uiLocale };
}

/** Membre ciblé, relu en base dans l'organisation du contexte (RLS : owner/admin voient tous les membres). */
async function fetchTargetMember(
  supabase: ServerSupabase,
  ctx: TenantContext,
  memberId: string,
): Promise<MemberRow | "not_found" | "error"> {
  const { data, error } = await supabase
    .from("organization_members")
    .select("id, user_id, role, status, created_at")
    .eq("id", memberId)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();
  if (error) return "error";
  if (!data) return "not_found";
  const parsed = memberRowSchema.safeParse(data);
  return parsed.success ? parsed.data : "error";
}

/** Y a-t-il un AUTRE owner actif ? (vérification préalable ; le trigger `protect_last_owner` reste le garde-fou.) */
async function hasOtherActiveOwner(supabase: ServerSupabase, ctx: TenantContext, excludeMemberId: string): Promise<boolean | "error"> {
  const { count, error } = await supabase
    .from("organization_members")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ctx.organizationId)
    .eq("role", "company_owner")
    .eq("status", "active")
    .neq("id", excludeMemberId);
  if (error || count === null) return "error";
  return count > 0;
}

function refresh(uiLocale: AuthLocale): void {
  revalidatePath(`/${uiLocale}/members`);
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

/**
 * Crée une invitation. Le jeton est généré ici, seul son hash est envoyé à la base ; le lien n'est
 * renvoyé QU'UNE FOIS dans la réponse (aucun e-mail au J10). Réinviter la même adresse révoque
 * l'invitation précédente dans la même transaction SQL.
 */
export async function inviteMemberAction(_prev: MembersActionState, formData: FormData): Promise<MembersActionState> {
  const input = inviteMemberSchema.safeParse({
    email: field(formData, "email"),
    role: field(formData, "role"),
    organization_id: field(formData, "organization_id"),
  });
  if (!input.success) return fail("invalid_input", toFieldErrors(input.error));

  const auth = await authorize(formData, input.data.organization_id);
  if (!auth.ok) return auth.state;
  const { ctx, supabase, uiLocale } = auth;

  if (!can(ctx.role, "invite", "members", { assignedRole: input.data.role })) return fail("forbidden");

  const { token, tokenHash } = generateInvitationToken();
  const { data, error } = await supabase.rpc("create_invitation", {
    p_org: ctx.organizationId,
    p_email: input.data.email,
    p_role: input.data.role,
    p_token_hash: tokenHash,
  });
  if (error) return fail(mapMembersDbError(error));
  if (!uuidSchema.safeParse(data).success) return fail("generic");

  // AUDIT (J11) : invitation créée (organisation, rôle, invitant) — sans e-mail ni jeton.
  refresh(uiLocale);
  return { status: "success", invitePath: `/${uiLocale}/invite/${token}` };
}

export async function revokeInvitationAction(_prev: MembersActionState, formData: FormData): Promise<MembersActionState> {
  const input = revokeInvitationSchema.safeParse({
    invitation_id: field(formData, "invitation_id"),
    organization_id: field(formData, "organization_id"),
  });
  if (!input.success) return fail("invalid_input", toFieldErrors(input.error));

  const auth = await authorize(formData, input.data.organization_id);
  if (!auth.ok) return auth.state;
  const { ctx, supabase, uiLocale } = auth;

  // Refus précoce, AVANT toute lecture base : un rôle sans droit « invite » sur les membres n'apprend rien.
  // Rôle neutre non-owner fourni pour la garde membre ; le contrôle fin (rôle réel de la cible) suit la lecture.
  if (!can(ctx.role, "invite", "members", { assignedRole: "analyst" })) return fail("forbidden");

  // Le rôle de l'invitation vient de la base : un admin ne révoque pas une invitation « owner ».
  const { data: row, error: readError } = await supabase
    .from("invitations")
    .select("role")
    .eq("id", input.data.invitation_id)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();
  if (readError) return fail("generic");
  if (!row) return fail("forbidden");
  const roleParsed = tenantRoleSchema.safeParse(row.role);
  if (!roleParsed.success) return fail("generic");
  if (!can(ctx.role, "invite", "members", { assignedRole: roleParsed.data })) return fail("forbidden");

  const { error } = await supabase.rpc("revoke_invitation", {
    p_org: ctx.organizationId,
    p_invitation_id: input.data.invitation_id,
  });
  if (error) return fail(mapMembersDbError(error));

  // AUDIT (J11) : invitation révoquée.
  refresh(uiLocale);
  return { status: "success" };
}

/**
 * Acceptation depuis /invite/[token]. Le hash du jeton part à la base ; TOUT échec (jeton inconnu,
 * expiré, révoqué, déjà accepté, e-mail différent, e-mail non confirmé, erreur technique) rend le
 * MÊME code `invitation_invalid` : rien ne fuit. Succès : organisation active posée, puis tableau de bord.
 */
export async function acceptInvitationAction(_prev: MembersActionState, formData: FormData): Promise<MembersActionState> {
  const uiLocale = uiLocaleOf(formData);
  const invalid = fail("invitation_invalid");

  const token = invitationTokenSchema.safeParse(field(formData, "token"));
  if (!token.success) return invalid;

  const supabase = await createClient();
  const userId = await getAuthenticatedUserId(supabase);
  if (!userId) redirect(`/${uiLocale}/login`);

  const { data, error } = await supabase.rpc("accept_invitation", { p_token_hash: hashInvitationToken(token.data) });
  if (error) return invalid;
  const organizationId = uuidSchema.safeParse(data);
  if (!organizationId.success) return invalid;

  // AUDIT (J11) : invitation acceptée (organisation, rôle attribué).
  // Le cookie n'est qu'un indice : getTenantContext le confronte de toute façon aux adhésions en base.
  await setActiveOrgCookie(organizationId.data);
  redirect(`/${uiLocale}/dashboard`);
}

// ---------------------------------------------------------------------------
// Membres : rôle, retrait, transfert de propriété (RLS/colonnes J7, aucune nouvelle fonction)
// ---------------------------------------------------------------------------

export async function changeMemberRoleAction(_prev: MembersActionState, formData: FormData): Promise<MembersActionState> {
  const input = changeRoleSchema.safeParse({
    member_id: field(formData, "member_id"),
    role: field(formData, "role"),
    organization_id: field(formData, "organization_id"),
  });
  if (!input.success) return fail("invalid_input", toFieldErrors(input.error));

  const auth = await authorize(formData, input.data.organization_id);
  if (!auth.ok) return auth.state;
  const { ctx, supabase, uiLocale } = auth;

  // Refus précoce, AVANT toute lecture base : un rôle sans droit « change_role » sur les membres n'apprend rien.
  // Rôle neutre non-owner fourni pour la garde membre ; le contrôle fin (rôle réel de la cible) suit la lecture.
  if (!can(ctx.role, "change_role", "members", { targetRole: "analyst", assignedRole: "analyst" })) return fail("forbidden");

  const target = await fetchTargetMember(supabase, ctx, input.data.member_id);
  if (target === "error") return fail("generic");
  if (target === "not_found" || target.status === "removed") return fail("forbidden");
  // Pas d'auto-modification : se rétrograder passe par le transfert de propriété (évite le verrouillage).
  if (target.user_id === ctx.userId) return fail("forbidden");
  if (!canManageMember(ctx.role, target.role, input.data.role)) return fail("forbidden");

  const newRole: TenantRole = input.data.role;
  if (target.role === "company_owner" && target.status === "active" && newRole !== "company_owner") {
    const other = await hasOtherActiveOwner(supabase, ctx, target.id);
    if (other === "error") return fail("generic");
    if (!other) return fail("last_owner");
  }

  const { data, error } = await supabase
    .from("organization_members")
    .update({ role: newRole })
    .eq("id", target.id)
    .eq("organization_id", ctx.organizationId)
    .neq("status", "removed")
    .select("id");
  if (error) return fail(mapMembersDbError(error));
  // La RLS filtre silencieusement : zéro ligne modifiée = refus.
  if (!Array.isArray(data) || data.length !== 1) return fail("forbidden");

  // AUDIT (J11) : rôle changé (ancien -> nouveau).
  refresh(uiLocale);
  return { status: "success" };
}

/** Retire un membre : statut `removed` via le client de l'utilisateur (jamais de suppression de ligne). */
export async function removeMemberAction(_prev: MembersActionState, formData: FormData): Promise<MembersActionState> {
  const input = removeMemberSchema.safeParse({
    member_id: field(formData, "member_id"),
    organization_id: field(formData, "organization_id"),
  });
  if (!input.success) return fail("invalid_input", toFieldErrors(input.error));

  const auth = await authorize(formData, input.data.organization_id);
  if (!auth.ok) return auth.state;
  const { ctx, supabase, uiLocale } = auth;

  // Refus précoce, AVANT toute lecture base : un rôle sans droit « remove » sur les membres n'apprend rien.
  // Rôle neutre non-owner fourni pour la garde membre ; le contrôle fin (rôle réel de la cible) suit la lecture.
  if (!can(ctx.role, "remove", "members", { targetRole: "analyst" })) return fail("forbidden");

  const target = await fetchTargetMember(supabase, ctx, input.data.member_id);
  if (target === "error") return fail("generic");
  if (target === "not_found" || target.status === "removed") return fail("forbidden");
  if (target.user_id === ctx.userId) return fail("forbidden");
  if (!canManageMember(ctx.role, target.role)) return fail("forbidden");

  if (target.role === "company_owner" && target.status === "active") {
    const other = await hasOtherActiveOwner(supabase, ctx, target.id);
    if (other === "error") return fail("generic");
    if (!other) return fail("last_owner");
  }

  const { data, error } = await supabase
    .from("organization_members")
    .update({ status: "removed" })
    .eq("id", target.id)
    .eq("organization_id", ctx.organizationId)
    .neq("status", "removed")
    .select("id");
  if (error) return fail(mapMembersDbError(error));
  if (!Array.isArray(data) || data.length !== 1) return fail("forbidden");

  // AUDIT (J11) : membre retiré.
  refresh(uiLocale);
  return { status: "success" };
}

/** Transfert de propriété : seul le Company Owner ; promotion de la cible et rétrogradation de l'appelant atomiques (RPC). */
export async function transferOwnershipAction(_prev: MembersActionState, formData: FormData): Promise<MembersActionState> {
  const input = transferOwnershipSchema.safeParse({
    member_id: field(formData, "member_id"),
    organization_id: field(formData, "organization_id"),
  });
  if (!input.success) return fail("invalid_input", toFieldErrors(input.error));

  const auth = await authorize(formData, input.data.organization_id);
  if (!auth.ok) return auth.state;
  const { ctx, supabase, uiLocale } = auth;

  if (!can(ctx.role, "transfer", "ownership")) return fail("forbidden");

  const target = await fetchTargetMember(supabase, ctx, input.data.member_id);
  if (target === "error") return fail("generic");
  if (target === "not_found" || target.status !== "active" || target.user_id === ctx.userId) return fail("forbidden");

  const { error } = await supabase.rpc("transfer_ownership", {
    p_org: ctx.organizationId,
    p_new_owner: target.user_id,
  });
  if (error) return fail(mapMembersDbError(error));

  // AUDIT (J11) : propriété transférée (ancien owner -> nouveau owner).
  refresh(uiLocale);
  return { status: "success" };
}
