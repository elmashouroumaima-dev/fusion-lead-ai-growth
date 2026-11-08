import { z } from "zod";
import { isSafeText } from "../projects/text";
import { uuidSchema } from "../tenant/schemas";

/**
 * Synchronisation CRM (J25, spec §9.1 étapes 5–6 et §6) : mapping de champs, sens et `source_of_truth`. Le CRM INTERNE reste la source de
 * vérité du MVP ; aucune synchro bidirectionnelle sans règle de conflit explicite (`resolveContactRecord`). Fonctions PURES.
 */
export const CRM_ENTITIES = ["contact"] as const;
export type CrmEntity = (typeof CRM_ENTITIES)[number];

/** Champs internes d'un contact qu'une synchro peut METTRE À JOUR (liste blanche : aucune écriture libre). */
export const CRM_UPDATABLE_FIELDS = ["name", "language", "country"] as const;
export type CrmUpdatableField = (typeof CRM_UPDATABLE_FIELDS)[number];
/** Identité : lue à la création ou pour rattacher un contact existant, JAMAIS écrasée sur un contact existant (consentement lié à l'adresse). */
export const CRM_IDENTITY_FIELDS = ["email", "phone"] as const;
export type CrmIdentityField = (typeof CRM_IDENTITY_FIELDS)[number];
/** Champs techniques : identifiant stable chez le fournisseur et date de dernière modification de son côté. */
export const CRM_TECHNICAL_FIELDS = ["external_id", "external_updated_at"] as const;

export const CRM_INTERNAL_FIELDS = [...CRM_TECHNICAL_FIELDS, ...CRM_IDENTITY_FIELDS, ...CRM_UPDATABLE_FIELDS] as const;
export type CrmInternalField = (typeof CRM_INTERNAL_FIELDS)[number];

export const CRM_SOURCES_OF_TRUTH = ["internal", "external"] as const;
export const CRM_DIRECTIONS = ["pull", "push", "both"] as const;
export type CrmSourceOfTruth = (typeof CRM_SOURCES_OF_TRUTH)[number];
export type CrmDirection = (typeof CRM_DIRECTIONS)[number];

export const CRM_PROVIDERS = ["csv", "internal"] as const;
export type CrmProvider = (typeof CRM_PROVIDERS)[number];

/** Nom d'un champ chez le fournisseur (en-tête de colonne CSV, nom d'attribut d'une API) : texte court sans contrôle. */
const externalFieldName = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => value === value.trim() && isSafeText(value, 1, 100), { message: "invalid_field_name" });

export const crmMappingEntrySchema = z
  .object({
    entity: z.enum(CRM_ENTITIES),
    internal_field: z.enum(CRM_INTERNAL_FIELDS),
    external_field: externalFieldName,
    source_of_truth: z.enum(CRM_SOURCES_OF_TRUTH),
    direction: z.enum(CRM_DIRECTIONS),
  })
  .strict();
export type CrmMappingEntry = z.infer<typeof crmMappingEntrySchema>;

/**
 * Jeu de mappings d'une intégration : 2 à 20 entrées, un seul mapping par champ interne et par colonne externe, `external_id`
 * OBLIGATOIRE (sans identifiant stable, pas de synchro idempotente), et seuls les champs d'identité ou techniques n'ont pas de
 * `source_of_truth` utile (ils sont lus, jamais en conflit).
 */
export const crmMappingsSchema = z
  .array(crmMappingEntrySchema)
  .min(2)
  .max(20)
  .refine((entries) => entries.some((entry) => entry.internal_field === "external_id"), { message: "external_id_required" })
  .refine((entries) => new Set(entries.map((entry) => entry.internal_field)).size === entries.length, { message: "duplicate_internal_field" })
  .refine((entries) => new Set(entries.map((entry) => entry.external_field)).size === entries.length, { message: "duplicate_external_field" })
  .refine(
    (entries) => entries.every((entry) => !(CRM_TECHNICAL_FIELDS as readonly string[]).includes(entry.internal_field) || entry.direction === "pull"),
    { message: "technical_field_pull_only" },
  );
export type CrmMappings = z.infer<typeof crmMappingsSchema>;

export const saveCrmMappingsSchema = z
  .object({ integration_id: uuidSchema, mappings: crmMappingsSchema })
  .strict();
export type SaveCrmMappingsInput = z.infer<typeof saveCrmMappingsSchema>;

export const createCrmIntegrationSchema = z.object({ provider: z.enum(CRM_PROVIDERS), external_account_id: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/) }).strict();
export type CreateCrmIntegrationInput = z.infer<typeof createCrmIntegrationSchema>;

/** Demande de synchro : un fichier CSV déjà envoyé (assistant d'import, J23) est la source du lot. */
export const requestCrmSyncSchema = z.object({ integration_id: uuidSchema, batch_id: uuidSchema }).strict();
export type RequestCrmSyncInput = z.infer<typeof requestCrmSyncSchema>;

export const retryCrmSyncSchema = z.object({ integration_id: uuidSchema }).strict();
export type RetryCrmSyncInput = z.infer<typeof retryCrmSyncSchema>;

export const CRM_SYNC_STATUSES = ["never", "queued", "running", "ok", "failed"] as const;
export const CRM_SYNC_ERROR_CODES = ["file_missing", "file_malformed", "mapping_invalid", "failed"] as const;

export const crmIntegrationRowSchema = z.object({
  id: uuidSchema,
  organization_id: uuidSchema,
  provider: z.enum(CRM_PROVIDERS),
  status: z.string(),
  external_account_id: z.string(),
  last_sync_at: z.string().nullable(),
  last_error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type CrmIntegrationRow = z.infer<typeof crmIntegrationRowSchema>;

export const crmMappingRowSchema = crmMappingEntrySchema.extend({ id: uuidSchema, integration_id: uuidSchema });
export type CrmMappingRow = z.infer<typeof crmMappingRowSchema>;
