import { z } from "zod";
import { httpsUrlSchema, safeText } from "../projects/text";
import { uuidSchema } from "../tenant/schemas";
import { normalizeContactEmail, normalizePhone } from "./normalize";

/**
 * Contacts et consentement (J18, spec §7 et §9, ADR 007 G-D3/G-D4, ADR 014). Source unique pour les Server Actions et la
 * lecture des lignes. `organization_id` éventuellement posté par l'interface n'est jamais une source de vérité.
 */

export const CONSENT_STATUSES = ["unknown", "granted", "revoked"] as const;
export const consentStatusSchema = z.enum(CONSENT_STATUSES);
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

/** Canaux (enum `channel_type` ; extensible par `alter type … add value`). */
export const CHANNEL_TYPES = ["email", "whatsapp"] as const;
export const channelTypeSchema = z.enum(CHANNEL_TYPES);
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const CONTACT_NAME_MAX = 200;
export const CONTACT_ATTRIBUTES_MAX_BYTES = 8192;

const claimedOrganization = uuidSchema.optional();
const blankToNull = (value: unknown) => (typeof value === "string" && value.trim() === "" ? null : value);
const optionalText = (min: number, max: number) => z.preprocess(blankToNull, safeText(min, max).nullable().optional());
/** Code court en minuscules (« marketing », « newsletter », « web_form »). */
const slug = (max: number) => z.string().regex(new RegExp(`^[a-z][a-z0-9_]{0,${max - 1}}$`));

const attributesSchema = z
  .record(safeText(1, 60), z.union([safeText(1, 500), z.number(), z.boolean(), z.null()]))
  .refine(
    (value) => Object.keys(value).length <= 50 && new TextEncoder().encode(JSON.stringify(value)).length <= CONTACT_ATTRIBUTES_MAX_BYTES,
    { message: "attributes_too_large" },
  );

const contactFields = {
  name: optionalText(1, CONTACT_NAME_MAX),
  email: z.preprocess(blankToNull, z.string().max(300).nullable().optional()),
  phone: z.preprocess(blankToNull, z.string().max(40).nullable().optional()),
  /** Pays utilisé pour lire un numéro national ; n'est pas enregistré. */
  default_country: z.preprocess(blankToNull, z.string().regex(/^[A-Z]{2}$/).nullable().optional()),
  language: z.preprocess(blankToNull, z.string().regex(/^[a-z]{2}$/).nullable().optional()),
  country: z.preprocess(blankToNull, z.string().regex(/^[A-Z]{2}$/).nullable().optional()),
  external_source: optionalText(1, 50),
  external_id: optionalText(1, 200),
  attributes: attributesSchema.optional(),
  organization_id: claimedOrganization,
};
type ContactFieldsInput = z.infer<z.ZodObject<typeof contactFields>>;

export type NormalizedContact = {
  name: string | null;
  email_raw: string | null;
  email_normalized: string | null;
  phone_e164: string | null;
  language: string | null;
  country: string | null;
  external_source: string | null;
  external_id: string | null;
  attributes: Record<string, string | number | boolean | null>;
  organization_id?: string | undefined;
};

/** Normalise e-mail et téléphone, exige au moins un identifiant et le couple source / identifiant externe. */
function normalizeContact(value: ContactFieldsInput, ctx: z.RefinementCtx): NormalizedContact {
  let emailRaw: string | null = null;
  let emailNormalized: string | null = null;
  let phone: string | null = null;
  if (value.email != null) {
    const email = normalizeContactEmail(value.email);
    if (email.ok) {
      emailRaw = value.email.trim();
      emailNormalized = email.value;
    } else {
      ctx.addIssue({ code: "custom", path: ["email"], message: "email_invalid" });
    }
  }
  if (value.phone != null) {
    const result = normalizePhone(value.phone, value.default_country ?? value.country ?? undefined);
    if (result.ok) phone = result.value;
    else ctx.addIssue({ code: "custom", path: ["phone"], message: "phone_invalid" });
  }
  if (value.email == null && value.phone == null) ctx.addIssue({ code: "custom", path: ["email"], message: "identifier_required" });
  if ((value.external_source == null) !== (value.external_id == null)) {
    ctx.addIssue({ code: "custom", path: ["external_id"], message: "external_pair_required" });
  }
  return {
    name: value.name ?? null,
    email_raw: emailRaw,
    email_normalized: emailNormalized,
    phone_e164: phone,
    language: value.language ?? null,
    country: value.country ?? null,
    external_source: value.external_source ?? null,
    external_id: value.external_id ?? null,
    attributes: value.attributes ?? {},
    organization_id: value.organization_id,
  };
}

export const createContactSchema = z.object(contactFields).transform(normalizeContact);
export const updateContactSchema = z
  .object({ contact_id: uuidSchema, ...contactFields })
  .transform((value, ctx) => ({ contact_id: value.contact_id, ...normalizeContact(value, ctx) }));
export type CreateContactInput = z.output<typeof createContactSchema>;
export type UpdateContactInput = z.output<typeof updateContactSchema>;

/** Preuve du consentement (ADR 007) : texte et version affichés, IP, URL de la page. Rien d'autre n'est conservé. */
export const consentProofSchema = z
  .object({
    consent_text: safeText(1, 2000, true).optional(),
    consent_version: safeText(1, 50).optional(),
    ip: z
      .string()
      .max(45)
      .regex(/^[0-9a-fA-F:.]+$/)
      .optional(),
    url: httpsUrlSchema.optional(),
  })
  .strict();
export type ConsentProof = z.infer<typeof consentProofSchema>;

export const recordConsentSchema = z.object({
  contact_id: uuidSchema,
  channel: channelTypeSchema,
  purpose: slug(50),
  source: slug(50),
  proof: consentProofSchema.default({}),
  organization_id: claimedOrganization,
});
export type RecordConsentInput = z.output<typeof recordConsentSchema>;

export const revokeConsentSchema = z.object({
  contact_id: uuidSchema,
  channel: channelTypeSchema,
  /** Finalité visée ; absente = toutes les finalités du canal. */
  purpose: slug(50).nullable().optional(),
  /** Bloque aussi tout envoi futur (liste « ne pas contacter »). */
  do_not_contact: z.boolean().default(false),
  organization_id: claimedOrganization,
});
export type RevokeConsentInput = z.output<typeof revokeConsentSchema>;

export const setDoNotContactSchema = z.object({ contact_id: uuidSchema, value: z.boolean(), organization_id: claimedOrganization });
export type SetDoNotContactInput = z.output<typeof setDoNotContactSchema>;

/** Lignes renvoyées par la base. */
export const contactRowSchema = z.object({
  id: uuidSchema,
  organization_id: uuidSchema,
  name: z.string().nullable(),
  email_raw: z.string().nullable(),
  email_normalized: z.string().nullable(),
  phone_e164: z.string().nullable(),
  language: z.string().nullable(),
  country: z.string().nullable(),
  consent_status: consentStatusSchema,
  do_not_contact: z.boolean(),
  external_source: z.string().nullable(),
  external_id: z.string().nullable(),
  attributes: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ContactRow = z.infer<typeof contactRowSchema>;

export const consentEventRowSchema = z.object({
  id: uuidSchema,
  organization_id: uuidSchema,
  contact_id: uuidSchema,
  channel: channelTypeSchema,
  purpose: z.string(),
  source: z.string(),
  proof: z.record(z.string(), z.unknown()),
  captured_at: z.string(),
  revoked_at: z.string().nullable(),
});
export type ConsentEventRow = z.infer<typeof consentEventRowSchema>;
