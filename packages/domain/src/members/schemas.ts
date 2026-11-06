import { z } from "zod";
import { tenantRoleSchema, uuidSchema } from "../tenant/schemas";

/**
 * Schémas des membres et des invitations (J10, ADR 014, ADR 007 G-R8). Source unique pour les
 * Server Actions et la lecture des lignes renvoyées par la base.
 */

/** Durée de validité d'une invitation (décision J10) : miroir de `interval '7 days'` dans `private.create_invitation`. */
export const INVITATION_EXPIRY_DAYS = 7;

/** E-mail le plus long autorisé (RFC 5321) : miroir de la contrainte SQL `length <= 254`. */
export const EMAIL_MAX_LENGTH = 254;

/**
 * Forme canonique d'une adresse : rognée et en minuscules. Miroir exact de `lower(btrim(...))`
 * côté SQL ; c'est la valeur comparée à `auth.users.email` à l'acceptation.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Forme simple : ASCII imprimable, une seule arobase, un domaine avec au moins un point. Les
 * adresses non ASCII sont refusées volontairement : `lower()` de JavaScript et celui de Postgres
 * peuvent diverger hors ASCII, ce qui casserait la comparaison d'e-mail à l'acceptation.
 * (Les domaines internationalisés s'écrivent en punycode, donc en ASCII.)
 */
const EMAIL_SHAPE = /^[\x21-\x7e]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export const memberEmailSchema = z
  .string()
  .max(512)
  .transform(normalizeEmail)
  .pipe(
    z
      .string()
      .min(3)
      .max(EMAIL_MAX_LENGTH)
      .refine((value) => value.split("@").length === 2 && EMAIL_SHAPE.test(value)),
  );

/**
 * `organization_id` éventuellement posté par l'interface : jamais une source de vérité, seulement
 * comparé au contexte vérifié (assertSameOrganization). Absent = rien de revendiqué.
 */
const claimedOrganization = uuidSchema.optional();

export const inviteMemberSchema = z
  .object({
    email: memberEmailSchema,
    role: tenantRoleSchema,
    organization_id: claimedOrganization,
  })
  .strict();
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const changeRoleSchema = z
  .object({
    member_id: uuidSchema,
    role: tenantRoleSchema,
    organization_id: claimedOrganization,
  })
  .strict();
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;

export const removeMemberSchema = z
  .object({
    member_id: uuidSchema,
    organization_id: claimedOrganization,
  })
  .strict();
export type RemoveMemberInput = z.infer<typeof removeMemberSchema>;

export const transferOwnershipSchema = z
  .object({
    member_id: uuidSchema,
    organization_id: claimedOrganization,
  })
  .strict();
export type TransferOwnershipInput = z.infer<typeof transferOwnershipSchema>;

export const revokeInvitationSchema = z
  .object({
    invitation_id: uuidSchema,
    organization_id: claimedOrganization,
  })
  .strict();
export type RevokeInvitationInput = z.infer<typeof revokeInvitationSchema>;

/** 32 octets aléatoires en base64url sans remplissage = 43 caractères. */
export const invitationTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** Empreinte stockée : sha256 en hexadécimal minuscule (64 caractères). */
export const invitationTokenHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

// ---------------------------------------------------------------------------
// Lignes lues en base (aucune donnée n'est consommée sans passer par zod)
// ---------------------------------------------------------------------------

export const MEMBER_STATUSES = ["invited", "active", "suspended", "removed"] as const;
export const memberStatusSchema = z.enum(MEMBER_STATUSES);
export type MemberStatus = z.infer<typeof memberStatusSchema>;

export const memberRowSchema = z.object({
  id: uuidSchema,
  user_id: uuidSchema,
  role: tenantRoleSchema,
  status: memberStatusSchema,
  created_at: z.string(),
});
export type MemberRow = z.infer<typeof memberRowSchema>;

export const invitationRowSchema = z.object({
  id: uuidSchema,
  email_normalized: z.string(),
  role: tenantRoleSchema,
  expires_at: z.string(),
  created_at: z.string(),
});
export type InvitationRow = z.infer<typeof invitationRowSchema>;
