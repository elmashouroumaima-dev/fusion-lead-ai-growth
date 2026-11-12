import { z } from "zod";
import { safeText } from "../projects/text";
import { uuidSchema } from "../tenant/schemas";

/**
 * Pipelines, leads et deals (J19, spec §7 et §9.1, ADR 007 E1/G-D3, ADR 014). Source unique pour le service et la lecture des
 * lignes. `organization_id` éventuellement posté par l'interface n'est jamais une source de vérité.
 */

export const STAGE_KINDS = ["open", "won", "lost", "unassigned"] as const;
export const stageKindSchema = z.enum(STAGE_KINDS);
export type StageKind = (typeof STAGE_KINDS)[number];
/** Genres qu'un utilisateur peut donner à une étape : « unassigned » est réservé à l'étape système de chaque pipeline. */
export const EDITABLE_STAGE_KINDS = ["open", "won", "lost"] as const;
export const editableStageKindSchema = z.enum(EDITABLE_STAGE_KINDS);

export const STAGE_NAME_MAX = 100;
export const PIPELINE_NAME_MAX = 100;
export const SCORE_MIN = 0;
export const SCORE_MAX = 100;
export const DEAL_VALUE_MAX = 999_999_999_999.99;

const claimedOrganization = uuidSchema.optional();
const blankToNull = (value: unknown) => (typeof value === "string" && value.trim() === "" ? null : value);
const slug = (max: number) => z.string().regex(new RegExp(`^[a-z][a-z0-9_]{0,${max - 1}}$`));

/** UTM et page d'atterrissage (ADR 007 : `landing_page_id` vit dans `utm`) : clés connues, valeurs textuelles courtes. */
export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "landing_page_id"] as const;
const utmValue = safeText(1, 200).optional();
export const utmSchema = z
  .object({
    utm_source: utmValue,
    utm_medium: utmValue,
    utm_campaign: utmValue,
    utm_term: utmValue,
    utm_content: utmValue,
    landing_page_id: utmValue,
  })
  .strict();
export type Utm = z.infer<typeof utmSchema>;

const scoreSchema = z.number().int().min(SCORE_MIN).max(SCORE_MAX);
/** Raisons d'un score : objet JSON borné (4 Ko). */
const scoreReasonSchema = z
  .record(z.string().min(1).max(60), z.unknown())
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= 4096, { message: "score_reason_too_large" });

const currencySchema = z.string().regex(/^[A-Z]{3}$/);
const valueSchema = z.number().min(0).max(DEAL_VALUE_MAX).refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, {
  message: "value_two_decimals",
});
const expectedCloseSchema = z.preprocess(blankToNull, z.iso.datetime({ offset: true }).nullable().optional());

// --- Pipelines et étapes ------------------------------------------------------------------------------------------------
export const createPipelineSchema = z.object({ name: safeText(1, PIPELINE_NAME_MAX), organization_id: claimedOrganization });
export const renamePipelineSchema = z.object({ pipeline_id: uuidSchema, name: safeText(1, PIPELINE_NAME_MAX), organization_id: claimedOrganization });
export const setDefaultPipelineSchema = z.object({ pipeline_id: uuidSchema, organization_id: claimedOrganization });
export const createStageSchema = z.object({
  pipeline_id: uuidSchema,
  name: safeText(1, STAGE_NAME_MAX),
  kind: editableStageKindSchema,
  /** Absente : après la dernière étape. */
  position: z.number().int().min(0).max(1_000_000).nullable().optional(),
  organization_id: claimedOrganization,
});
export const updateStageSchema = z.object({
  stage_id: uuidSchema,
  name: safeText(1, STAGE_NAME_MAX),
  position: z.number().int().min(0).max(1_000_000),
  organization_id: claimedOrganization,
});
export const deleteStageSchema = z.object({ stage_id: uuidSchema, organization_id: claimedOrganization });
export type CreatePipelineInput = z.output<typeof createPipelineSchema>;
export type RenamePipelineInput = z.output<typeof renamePipelineSchema>;
export type SetDefaultPipelineInput = z.output<typeof setDefaultPipelineSchema>;
export type CreateStageInput = z.output<typeof createStageSchema>;
export type UpdateStageInput = z.output<typeof updateStageSchema>;
export type DeleteStageInput = z.output<typeof deleteStageSchema>;

// --- Leads ----------------------------------------------------------------------------------------------------------------
export const createLeadSchema = z.object({
  contact_id: uuidSchema,
  project_id: uuidSchema,
  source: slug(50),
  assignee_id: uuidSchema.nullable().optional(),
  score: scoreSchema.nullable().optional(),
  score_reason: scoreReasonSchema.optional(),
  utm: utmSchema.optional(),
  external_source: z.preprocess(blankToNull, safeText(1, 50).nullable().optional()),
  external_id: z.preprocess(blankToNull, safeText(1, 200).nullable().optional()),
  organization_id: claimedOrganization,
});
export const updateLeadSchema = z.object({
  lead_id: uuidSchema,
  source: slug(50),
  score: scoreSchema.nullable().optional(),
  score_reason: scoreReasonSchema.optional(),
  utm: utmSchema.optional(),
  organization_id: claimedOrganization,
});
export const assignLeadSchema = z.object({ lead_id: uuidSchema, assignee_id: uuidSchema.nullable(), organization_id: claimedOrganization });
export const moveLeadStageSchema = z.object({ lead_id: uuidSchema, stage_id: uuidSchema, organization_id: claimedOrganization });
export type CreateLeadInput = z.output<typeof createLeadSchema>;
export type UpdateLeadInput = z.output<typeof updateLeadSchema>;
export type AssignLeadInput = z.output<typeof assignLeadSchema>;
export type MoveLeadStageInput = z.output<typeof moveLeadStageSchema>;

// --- Deals ----------------------------------------------------------------------------------------------------------------
export const createDealSchema = z.object({
  lead_id: uuidSchema,
  /** Absente : première étape ouverte du pipeline du lead. */
  stage_id: uuidSchema.nullable().optional(),
  value: valueSchema,
  currency: currencySchema,
  expected_close_at: expectedCloseSchema,
  organization_id: claimedOrganization,
});
export const updateDealSchema = z.object({
  deal_id: uuidSchema,
  value: valueSchema,
  currency: currencySchema,
  expected_close_at: expectedCloseSchema,
  organization_id: claimedOrganization,
});
export const moveDealStageSchema = z.object({ deal_id: uuidSchema, stage_id: uuidSchema, organization_id: claimedOrganization });
export type CreateDealInput = z.output<typeof createDealSchema>;
export type UpdateDealInput = z.output<typeof updateDealSchema>;
export type MoveDealStageInput = z.output<typeof moveDealStageSchema>;

// --- Lignes renvoyées par la base ---------------------------------------------------------------------------------------
export const pipelineRowSchema = z.object({
  id: uuidSchema,
  organization_id: uuidSchema,
  name: z.string(),
  is_default: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type PipelineRow = z.infer<typeof pipelineRowSchema>;

export const pipelineStageRowSchema = z.object({
  id: uuidSchema,
  organization_id: uuidSchema,
  pipeline_id: uuidSchema,
  name: z.string(),
  position: z.number().int(),
  kind: stageKindSchema,
  created_at: z.string(),
  updated_at: z.string(),
});
export type PipelineStageRow = z.infer<typeof pipelineStageRowSchema>;

export const leadRowSchema = z.object({
  id: uuidSchema,
  organization_id: uuidSchema,
  contact_id: uuidSchema,
  project_id: uuidSchema,
  source: z.string(),
  stage_id: uuidSchema,
  score: z.number().int().nullable(),
  score_reason: z.record(z.string(), z.unknown()),
  assignee_id: uuidSchema.nullable(),
  campaign_id: uuidSchema.nullable(),
  utm: z.record(z.string(), z.unknown()),
  external_source: z.string().nullable(),
  external_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type LeadRow = z.infer<typeof leadRowSchema>;

export const dealRowSchema = z.object({
  id: uuidSchema,
  organization_id: uuidSchema,
  lead_id: uuidSchema,
  stage_id: uuidSchema,
  value: z.union([z.number(), z.string()]).transform((value) => Number(value)),
  currency: z.string(),
  expected_close_at: z.string().nullable(),
  won_at: z.string().nullable(),
  lost_at: z.string().nullable(),
  external_source: z.string().nullable(),
  external_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type DealRow = z.infer<typeof dealRowSchema>;
