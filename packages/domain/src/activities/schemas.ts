import { z } from "zod";
import { safeText } from "../projects/text";
import { uuidSchema } from "../tenant/schemas";

/**
 * Activités et chronologie d'un lead (J20, spec §3 et §7, ADR 007 `activities`, ADR 014). Le contenu vit dans `metadata`, par
 * type (pas de colonne texte dans l'ADR). `organization_id` éventuellement posté par l'interface n'est jamais une source de
 * vérité.
 */

export const ACTIVITY_TYPES = ["note", "call", "email", "task", "meeting", "stage_change", "assignment"] as const;
export const activityTypeSchema = z.enum(ACTIVITY_TYPES);
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
/** Types qu'un utilisateur peut créer : `stage_change` et `assignment` sont écrits par la base. */
export const MANUAL_ACTIVITY_TYPES = ["note", "call", "email", "task", "meeting"] as const;
export const manualActivityTypeSchema = z.enum(MANUAL_ACTIVITY_TYPES);
export type ManualActivityType = (typeof MANUAL_ACTIVITY_TYPES)[number];

export const CALL_OUTCOMES = ["answered", "no_answer", "voicemail", "busy", "wrong_number"] as const;
export const TEXT_MAX = 2000;
export const TITLE_MAX = 200;
export const ACTIVITIES_PER_LEAD_MAX = 500;

const claimedOrganization = uuidSchema.optional();
const text = safeText(1, TEXT_MAX, true);
const title = safeText(1, TITLE_MAX);

// --- Contenu par type (miroir de `private.is_valid_activity_metadata`) ----------------------------------------------------
export const noteMetadataSchema = z.object({ text }).strict();
export const callMetadataSchema = z
  .object({
    text: text.optional(),
    outcome: z.enum(CALL_OUTCOMES).optional(),
    duration_minutes: z.number().int().min(0).max(600).optional(),
  })
  .strict()
  .refine((value) => value.text !== undefined || value.outcome !== undefined, { message: "text_or_outcome_required" });
export const emailMetadataSchema = z.object({ subject: title, text: text.optional() }).strict();
export const meetingMetadataSchema = z.object({ title, text: text.optional() }).strict();
export const taskMetadataSchema = z.object({ title, text: text.optional() }).strict();

export const METADATA_SCHEMAS = {
  note: noteMetadataSchema,
  call: callMetadataSchema,
  email: emailMetadataSchema,
  meeting: meetingMetadataSchema,
  task: taskMetadataSchema,
} as const;

const dueAtSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z.iso.datetime({ offset: true }).nullable().optional(),
);

/**
 * Création d'une activité manuelle. Le contenu est validé selon le type ; une échéance n'a de sens que pour une tâche ou un
 * rendez-vous ; le responsable n'a de sens que pour une tâche (absent : l'auteur).
 */
export const createActivitySchema = z
  .object({
    lead_id: uuidSchema,
    type: manualActivityTypeSchema,
    metadata: z.record(z.string(), z.unknown()),
    due_at: dueAtSchema,
    owner_id: uuidSchema.nullable().optional(),
    organization_id: claimedOrganization,
  })
  .superRefine((value, ctx) => {
    const parsed = METADATA_SCHEMAS[value.type].safeParse(value.metadata);
    if (!parsed.success) ctx.addIssue({ code: "custom", path: ["metadata"], message: "metadata_invalid" });
    if (value.due_at != null && value.type !== "task" && value.type !== "meeting") {
      ctx.addIssue({ code: "custom", path: ["due_at"], message: "due_at_not_allowed" });
    }
    if (value.owner_id != null && value.type !== "task") ctx.addIssue({ code: "custom", path: ["owner_id"], message: "owner_not_allowed" });
  });
export type CreateActivityInput = z.output<typeof createActivitySchema>;

/** Modification d'une tâche (les autres types ne changent jamais). */
/** `due_at` est OBLIGATOIRE (nul = retirer l'échéance) : une omission ne doit jamais l'effacer par erreur. */
const requiredDueAtSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z.iso.datetime({ offset: true }).nullable(),
);

export const updateTaskSchema = z.object({
  activity_id: uuidSchema,
  metadata: taskMetadataSchema,
  due_at: requiredDueAtSchema,
  owner_id: uuidSchema.nullable().optional(),
  organization_id: claimedOrganization,
});
export type UpdateTaskInput = z.output<typeof updateTaskSchema>;

export const completeTaskSchema = z.object({ activity_id: uuidSchema, done: z.boolean(), organization_id: claimedOrganization });
export type CompleteTaskInput = z.output<typeof completeTaskSchema>;

/** Lignes renvoyées par la base. */
export const activityRowSchema = z.object({
  id: uuidSchema,
  organization_id: uuidSchema,
  lead_id: uuidSchema,
  contact_id: uuidSchema,
  type: activityTypeSchema,
  owner_id: uuidSchema.nullable(),
  due_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ActivityRow = z.infer<typeof activityRowSchema>;
