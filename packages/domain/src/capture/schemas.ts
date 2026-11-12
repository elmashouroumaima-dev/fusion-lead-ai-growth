import { z } from "zod";
import { normalizeContactEmail, normalizePhone } from "../contacts/normalize";
import { utmSchema } from "../leads/schemas";
import { httpsUrlSchema, safeText } from "../projects/text";
import { uuidSchema } from "../tenant/schemas";

/**
 * Capture publique de leads (J21, spec §9.1 et §13-3, ADR 007 `form_keys`). Contrat du formulaire d'un site : la clé de formulaire
 * voyage dans l'en-tête `X-Form-Key` (jamais dans le corps ni l'URL), l'entreprise et le projet en sont DÉDUITS. Un corps qui
 * nomme une entreprise ou un projet est refusé (champ inconnu).
 */

/** Clé de formulaire : préfixe `flk_` + 64 caractères hexadécimaux (générée par la base). */
export const FORM_KEY_PATTERN = /^flk_[0-9a-f]{64}$/;
export const formKeySchema = z.string().regex(FORM_KEY_PATTERN);

export const CAPTURE_BODY_MAX_BYTES = 16 * 1024;
export const CONSENT_TEXT_MAX = 2000;

const blankToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

const consentSchema = z
  .object({
    channel: z.enum(["email", "whatsapp"]),
    /** Finalités admises par le formulaire public (la base les impose aussi) : jamais un code libre choisi par le visiteur. */
    purpose: z.enum(["marketing", "newsletter"]).default("marketing"),
    /** Texte EXACT affiché au visiteur et sa version : sans eux, pas de consentement. */
    text: safeText(1, CONSENT_TEXT_MAX, true),
    version: safeText(1, 50),
  })
  .strict();

const bodySchema = z
  .object({
    name: z.preprocess(blankToUndefined, safeText(1, 200).optional()),
    email: z.preprocess(blankToUndefined, z.string().max(300).optional()),
    phone: z.preprocess(blankToUndefined, z.string().max(40).optional()),
    /** Pays utilisé pour lire un numéro national ; n'est pas enregistré. */
    default_country: z.preprocess(blankToUndefined, z.string().regex(/^[A-Z]{2}$/).optional()),
    language: z.preprocess(blankToUndefined, z.string().regex(/^[a-z]{2}$/).optional()),
    country: z.preprocess(blankToUndefined, z.string().regex(/^[A-Z]{2}$/).optional()),
    utm: utmSchema.optional(),
    consent: consentSchema.optional(),
    /** Page où se trouve le formulaire (conservée dans la preuve du consentement). */
    page_url: z.preprocess(blankToUndefined, httpsUrlSchema.optional()),
    /** Champ piège : invisible pour un humain ; rempli, la soumission est acceptée en apparence mais ignorée. */
    website: z.string().max(500).optional(),
  })
  .strict();

export type CaptureConsent = {
  channel: "email" | "whatsapp";
  purpose: string;
  text: string;
  version: string;
  page_url: string | null;
};

export type CapturePayload = {
  /** Vrai si le champ piège est rempli (soumission à ignorer sans rien écrire). */
  honeypot: boolean;
  name: string | null;
  email_raw: string | null;
  email_normalized: string | null;
  phone_e164: string | null;
  language: string | null;
  country: string | null;
  utm: Record<string, string>;
  consent: CaptureConsent | null;
};

/** Corps du formulaire : validé strictement, e-mail et téléphone normalisés, au moins un identifiant. */
export const capturePayloadSchema = bodySchema.transform((value, ctx): CapturePayload => {
  let emailRaw: string | null = null;
  let emailNormalized: string | null = null;
  let phone: string | null = null;
  if (value.email !== undefined) {
    const email = normalizeContactEmail(value.email);
    if (email.ok) {
      emailRaw = value.email.trim();
      emailNormalized = email.value;
    } else {
      ctx.addIssue({ code: "custom", path: ["email"], message: "email_invalid" });
    }
  }
  if (value.phone !== undefined) {
    const result = normalizePhone(value.phone, value.default_country ?? value.country);
    if (result.ok) phone = result.value;
    else ctx.addIssue({ code: "custom", path: ["phone"], message: "phone_invalid" });
  }
  if (value.email === undefined && value.phone === undefined) ctx.addIssue({ code: "custom", path: ["email"], message: "identifier_required" });
  const utm: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value.utm ?? {})) if (typeof entry === "string") utm[key] = entry;
  return {
    honeypot: value.website !== undefined && value.website.trim() !== "",
    name: value.name ?? null,
    email_raw: emailRaw,
    email_normalized: emailNormalized,
    phone_e164: phone,
    language: value.language ?? null,
    country: value.country ?? null,
    utm,
    consent: value.consent
      ? { channel: value.consent.channel, purpose: value.consent.purpose, text: value.consent.text, version: value.consent.version, page_url: value.page_url ?? null }
      : null,
  };
});

/** Preuve du consentement envoyée à la base : texte, version, page (https) et IP (si lisible) ; rien d'autre. */
export function buildConsentProof(consent: CaptureConsent, ip: string | null): Record<string, string> {
  const proof: Record<string, string> = { consent_text: consent.text, consent_version: consent.version };
  if (consent.page_url) proof.url = consent.page_url;
  if (ip !== null && /^[0-9a-fA-F:.]{2,45}$/.test(ip)) proof.ip = ip;
  return proof;
}

// --- Gestion des clés par owner / admin ----------------------------------------------------------------------------------
const originSchema = z
  .string()
  .max(255)
  .regex(/^https:\/\/[^/?#]+$/)
  .refine((value) => value === value.toLowerCase(), { message: "origin_lowercase" });
/** 1 à 10 origines https exactes, sans doublon (la base re-contrôle : aucun joker, aucune IP, aucun hôte interne). */
export const allowedOriginsSchema = z
  .array(originSchema)
  .min(1)
  .max(10)
  .refine((origins) => new Set(origins).size === origins.length, { message: "origins_unique" });

const claimedOrganization = uuidSchema.optional();
export const createFormKeySchema = z.object({ project_id: uuidSchema, allowed_origins: allowedOriginsSchema, organization_id: claimedOrganization });
export const setFormKeyActiveSchema = z.object({ key_id: uuidSchema, active: z.boolean(), organization_id: claimedOrganization });
export const setFormKeyOriginsSchema = z.object({ key_id: uuidSchema, allowed_origins: allowedOriginsSchema, organization_id: claimedOrganization });
export type CreateFormKeyInput = z.output<typeof createFormKeySchema>;
export type SetFormKeyActiveInput = z.output<typeof setFormKeyActiveSchema>;
export type SetFormKeyOriginsInput = z.output<typeof setFormKeyOriginsSchema>;

/** Ligne lisible par owner / admin (sans l'empreinte de la clé). */
export const formKeyRowSchema = z.object({
  id: uuidSchema,
  organization_id: uuidSchema,
  project_id: uuidSchema,
  key_prefix: z.string(),
  allowed_origins: z.array(z.string()),
  active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type FormKeyRow = z.infer<typeof formKeyRowSchema>;
