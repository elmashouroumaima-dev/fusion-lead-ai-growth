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
import { serviceCodeToFormCode, uiLocaleOf } from "../service/form";
import { redirectTo, withAction, type ActionFailure, type ServiceSchema } from "../service/with-service";
import { setActiveOrgCookie } from "../tenant/active-org-cookie";
import type { TenantContext } from "../tenant/context";
import type { ServerSupabase } from "../tenant/identity";
import { fail } from "./form";
import { mapMembersDbError } from "./map-error";
import { generateInvitationToken, hashInvitationToken } from "./token";
import type { MembersActionState } from "./types";

/*
 * Server Actions de la page Membres (J10), branchées sur la couche service (J11, `withAction`).
 * Le pipeline commun (zod, contexte tenant relu en base, comparaison de l'organization_id posté,
 * can(), limitation de débit, idempotence) est dans lib/service/with-service.ts ; ici ne restent que
 * les règles propres à chaque action. Principes inchangés :
 *  - l'identifiant d'organisation n'est JAMAIS lu du formulaire comme vérité : le contexte décide ;
 *  - `can()` / `canManageMember()` AVANT la base (défense en profondeur) ; la RLS et les fonctions
 *    SQL restent l'autorité finale ;
 *  - le rôle de la cible vient de la base, jamais du formulaire ;
 *  - on ne renvoie que des codes ; jamais de jeton, d'e-mail ou d'empreinte dans un journal.
 *
 * Réservé J12 (volontairement non construit, listé au rapport) : écriture dans audit_logs. Les points
 * d'insertion sont marqués « AUDIT ».
 */

const failure = ({ code, fieldErrors }: ActionFailure): MembersActionState => fail(serviceCodeToFormCode(code), fieldErrors);
const loginPath = (formData: FormData): string => `/${uiLocaleOf(formData)}/login`;

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

const inviteMember = withAction(
  {
    name: "members.invite",
    auth: "tenant",
    schema: inviteMemberSchema,
    fields: ["email", "role", "organization_id"],
    permission: { action: "invite", resource: "members", ctx: (input) => ({ assignedRole: input.role }) },
    rateLimit: "sensitive",
    // Le lien d'invitation (secret) ne doit JAMAIS être conservé : un rejeu répond « duplicate_request ».
    idempotency: { mode: "required", storeResponse: false },
    secretFields: ["invitePath"],
    failure,
    loginPath,
  },
  async (ctx, input): Promise<MembersActionState> => {
    const uiLocale = uiLocaleOf(ctx.formData);
    const { token, tokenHash } = generateInvitationToken();
    const { data, error } = await ctx.supabase.rpc("create_invitation", {
      p_org: ctx.organizationId,
      p_email: input.email,
      p_role: input.role,
      p_token_hash: tokenHash,
    });
    if (error) return fail(mapMembersDbError(error));
    if (!uuidSchema.safeParse(data).success) return fail("generic");

    // AUDIT (J12) : invitation créée (organisation, rôle, invitant) — sans e-mail ni jeton.
    refresh(uiLocale);
    return { status: "success", invitePath: `/${uiLocale}/invite/${token}` };
  },
);

/**
 * Crée une invitation. Le jeton est généré ici, seul son hash est envoyé à la base ; le lien n'est
 * renvoyé QU'UNE FOIS dans la réponse (aucun e-mail au J10). Réinviter la même adresse révoque
 * l'invitation précédente dans la même transaction SQL. Idempotence obligatoire (champ caché
 * `idempotency_key`) : un rejeu ne crée pas de seconde invitation et ne révoque pas la première.
 */
export async function inviteMemberAction(prev: MembersActionState, formData: FormData): Promise<MembersActionState> {
  return inviteMember(prev, formData);
}

const revokeInvitation = withAction(
  {
    name: "members.revoke_invitation",
    auth: "tenant",
    schema: revokeInvitationSchema,
    fields: ["invitation_id", "organization_id"],
    // Refus précoce, AVANT toute lecture base : un rôle sans droit « invite » sur les membres n'apprend rien.
    // Rôle neutre non-owner fourni pour la garde membre ; le contrôle fin (rôle réel de la cible) suit la lecture.
    permission: { action: "invite", resource: "members", ctx: () => ({ assignedRole: "analyst" }) },
    rateLimit: "sensitive",
    idempotency: { mode: "optional", storeResponse: true },
    failure,
    loginPath,
  },
  async (ctx, input): Promise<MembersActionState> => {
    const { supabase } = ctx;
    const uiLocale = uiLocaleOf(ctx.formData);

    // Le rôle de l'invitation vient de la base : un admin ne révoque pas une invitation « owner ».
    const { data: row, error: readError } = await supabase
      .from("invitations")
      .select("role")
      .eq("id", input.invitation_id)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle();
    if (readError) return fail("generic");
    if (!row) return fail("forbidden");
    const roleParsed = tenantRoleSchema.safeParse(row.role);
    if (!roleParsed.success) return fail("generic");
    if (!can(ctx.role, "invite", "members", { assignedRole: roleParsed.data })) return fail("forbidden");

    const { error } = await supabase.rpc("revoke_invitation", {
      p_org: ctx.organizationId,
      p_invitation_id: input.invitation_id,
    });
    if (error) return fail(mapMembersDbError(error));

    // AUDIT (J12) : invitation révoquée.
    refresh(uiLocale);
    return { status: "success" };
  },
);

export async function revokeInvitationAction(prev: MembersActionState, formData: FormData): Promise<MembersActionState> {
  return revokeInvitation(prev, formData);
}

/** Le formulaire ne porte que le jeton (champ `token`) : le schéma du domaine valide la chaîne seule. */
const acceptInvitationSchema: ServiceSchema<string> = {
  safeParse: (raw) => invitationTokenSchema.safeParse((raw as { token?: unknown }).token),
};

const acceptInvitation = withAction(
  {
    name: "members.accept_invitation",
    auth: "user",
    schema: acceptInvitationSchema,
    fields: ["token"],
    rateLimit: "sensitive",
    idempotency: "none", // l'acceptation est naturellement à usage unique (le jeton est consommé)
    // TOUT échec (jeton inconnu, expiré, révoqué, déjà accepté, e-mail différent, panne, limite...) rend le MÊME code.
    failure: (): MembersActionState => fail("invitation_invalid"),
    loginPath,
  },
  async (ctx, token): Promise<MembersActionState | ReturnType<typeof redirectTo>> => {
    const { data, error } = await ctx.supabase.rpc("accept_invitation", { p_token_hash: hashInvitationToken(token) });
    if (error) return fail("invitation_invalid");
    const organizationId = uuidSchema.safeParse(data);
    if (!organizationId.success) return fail("invitation_invalid");

    // AUDIT (J12) : invitation acceptée (organisation, rôle attribué).
    // Le cookie n'est qu'un indice : getTenantContext le confronte de toute façon aux adhésions en base.
    await setActiveOrgCookie(organizationId.data);
    return redirectTo(`/${uiLocaleOf(ctx.formData)}/dashboard`);
  },
);

/**
 * Acceptation depuis /invite/[token] (couche service : session, limite « sensible »). Le hash du jeton part
 * à la base ; TOUT échec rend le MÊME code `invitation_invalid` : rien ne fuit. Session absente : redirection
 * vers la connexion. Succès : organisation active posée, puis tableau de bord.
 */
export async function acceptInvitationAction(prev: MembersActionState, formData: FormData): Promise<MembersActionState> {
  return acceptInvitation(prev, formData);
}

// ---------------------------------------------------------------------------
// Membres : rôle, retrait, transfert de propriété (RLS/colonnes J7, aucune nouvelle fonction)
// ---------------------------------------------------------------------------

const changeMemberRole = withAction(
  {
    name: "members.change_role",
    auth: "tenant",
    schema: changeRoleSchema,
    fields: ["member_id", "role", "organization_id"],
    // Refus précoce, AVANT toute lecture base ; le contrôle fin (rôle réel de la cible) suit la lecture.
    permission: { action: "change_role", resource: "members", ctx: () => ({ targetRole: "analyst", assignedRole: "analyst" }) },
    rateLimit: "sensitive",
    idempotency: { mode: "optional", storeResponse: true },
    failure,
    loginPath,
  },
  async (ctx, input): Promise<MembersActionState> => {
    const { supabase, tenant } = ctx;
    const uiLocale = uiLocaleOf(ctx.formData);

    const target = await fetchTargetMember(supabase, tenant, input.member_id);
    if (target === "error") return fail("generic");
    if (target === "not_found" || target.status === "removed") return fail("forbidden");
    // Pas d'auto-modification : se rétrograder passe par le transfert de propriété (évite le verrouillage).
    if (target.user_id === ctx.userId) return fail("forbidden");
    if (!canManageMember(ctx.role, target.role, input.role)) return fail("forbidden");

    const newRole: TenantRole = input.role;
    if (target.role === "company_owner" && target.status === "active" && newRole !== "company_owner") {
      const other = await hasOtherActiveOwner(supabase, tenant, target.id);
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

    // AUDIT (J12) : rôle changé (ancien -> nouveau).
    refresh(uiLocale);
    return { status: "success" };
  },
);

export async function changeMemberRoleAction(prev: MembersActionState, formData: FormData): Promise<MembersActionState> {
  return changeMemberRole(prev, formData);
}

const removeMember = withAction(
  {
    name: "members.remove",
    auth: "tenant",
    schema: removeMemberSchema,
    fields: ["member_id", "organization_id"],
    permission: { action: "remove", resource: "members", ctx: () => ({ targetRole: "analyst" }) },
    rateLimit: "sensitive",
    idempotency: { mode: "optional", storeResponse: true },
    failure,
    loginPath,
  },
  async (ctx, input): Promise<MembersActionState> => {
    const { supabase, tenant } = ctx;
    const uiLocale = uiLocaleOf(ctx.formData);

    const target = await fetchTargetMember(supabase, tenant, input.member_id);
    if (target === "error") return fail("generic");
    if (target === "not_found" || target.status === "removed") return fail("forbidden");
    if (target.user_id === ctx.userId) return fail("forbidden");
    if (!canManageMember(ctx.role, target.role)) return fail("forbidden");

    if (target.role === "company_owner" && target.status === "active") {
      const other = await hasOtherActiveOwner(supabase, tenant, target.id);
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

    // AUDIT (J12) : membre retiré.
    refresh(uiLocale);
    return { status: "success" };
  },
);

/** Retire un membre : statut `removed` via le client de l'utilisateur (jamais de suppression de ligne). */
export async function removeMemberAction(prev: MembersActionState, formData: FormData): Promise<MembersActionState> {
  return removeMember(prev, formData);
}

const transferOwnership = withAction(
  {
    name: "members.transfer_ownership",
    auth: "tenant",
    schema: transferOwnershipSchema,
    fields: ["member_id", "organization_id"],
    permission: { action: "transfer", resource: "ownership" },
    rateLimit: "sensitive",
    // Opération rare et lourde : idempotence obligatoire ; la réponse ({status:"success"}) ne contient aucun secret.
    idempotency: { mode: "required", storeResponse: true },
    failure,
    loginPath,
  },
  async (ctx, input): Promise<MembersActionState> => {
    const { supabase, tenant } = ctx;
    const uiLocale = uiLocaleOf(ctx.formData);

    const target = await fetchTargetMember(supabase, tenant, input.member_id);
    if (target === "error") return fail("generic");
    if (target === "not_found" || target.status !== "active" || target.user_id === ctx.userId) return fail("forbidden");

    const { error } = await supabase.rpc("transfer_ownership", {
      p_org: ctx.organizationId,
      p_new_owner: target.user_id,
    });
    if (error) return fail(mapMembersDbError(error));

    // AUDIT (J12) : propriété transférée (ancien owner -> nouveau owner).
    refresh(uiLocale);
    return { status: "success" };
  },
);

/** Transfert de propriété : seul le Company Owner ; promotion de la cible et rétrogradation de l'appelant atomiques (RPC). */
export async function transferOwnershipAction(prev: MembersActionState, formData: FormData): Promise<MembersActionState> {
  return transferOwnership(prev, formData);
}
