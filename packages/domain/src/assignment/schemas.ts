import { z } from "zod";
import { uuidSchema } from "../tenant/schemas";

/** Stratégies d'assignation (ADR 007 `assignment_rules`). */
export const ASSIGNMENT_STRATEGIES = ["round_robin", "fixed"] as const;
export const assignmentStrategySchema = z.enum(ASSIGNMENT_STRATEGIES);
export type AssignmentStrategy = z.infer<typeof assignmentStrategySchema>;

export const MAX_ELIGIBLE_MEMBERS = 50;

/** Membres éligibles : 1 à 50 identifiants d'utilisateur, sans doublon. */
export const eligibleMembersSchema = z
  .array(uuidSchema)
  .min(1)
  .max(MAX_ELIGIBLE_MEMBERS)
  .refine((ids) => new Set(ids).size === ids.length, { message: "duplicate_members" });

/** Règle cohérente : `fixed` désigne exactement un membre. */
function fixedHasOneMember(value: { strategy: AssignmentStrategy; eligible_member_ids: string[] }): boolean {
  return value.strategy !== "fixed" || value.eligible_member_ids.length === 1;
}
const FIXED_MESSAGE = { message: "fixed_requires_one_member", path: ["eligible_member_ids"] };

/** `project_id` absent = règle par défaut de l'entreprise. L'entreprise vient du contexte, jamais du corps. */
export const createAssignmentRuleSchema = z
  .object({
    project_id: uuidSchema.nullish().transform((value) => value ?? null),
    strategy: assignmentStrategySchema,
    eligible_member_ids: eligibleMembersSchema,
  })
  .strict()
  .refine(fixedHasOneMember, FIXED_MESSAGE);
export type CreateAssignmentRuleInput = z.infer<typeof createAssignmentRuleSchema>;

export const updateAssignmentRuleSchema = z
  .object({
    rule_id: uuidSchema,
    strategy: assignmentStrategySchema,
    eligible_member_ids: eligibleMembersSchema,
    active: z.boolean(),
  })
  .strict()
  .refine(fixedHasOneMember, FIXED_MESSAGE);
export type UpdateAssignmentRuleInput = z.infer<typeof updateAssignmentRuleSchema>;

export const deleteAssignmentRuleSchema = z.object({ rule_id: uuidSchema }).strict();
export type DeleteAssignmentRuleInput = z.infer<typeof deleteAssignmentRuleSchema>;

export const markNotificationReadSchema = z.object({ notification_id: uuidSchema }).strict();
export type MarkNotificationReadInput = z.infer<typeof markNotificationReadSchema>;

/** Ligne de règle lisible par owner / admin. */
export const assignmentRuleRowSchema = z.object({
  id: uuidSchema,
  organization_id: uuidSchema,
  project_id: uuidSchema.nullable(),
  strategy: assignmentStrategySchema,
  eligible_member_ids: z.array(uuidSchema),
  cursor: z.number().int(),
  active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type AssignmentRuleRow = z.infer<typeof assignmentRuleRowSchema>;

export const NOTIFICATION_KINDS = ["lead.unassigned"] as const;
export const UNASSIGNED_REASONS = ["no_rule", "no_eligible", "failed"] as const;

/** Notification in-app : la charge utile ne contient que des identifiants et un motif. */
export const notificationRowSchema = z.object({
  id: uuidSchema,
  organization_id: uuidSchema,
  recipient_id: uuidSchema.nullable(),
  kind: z.enum(NOTIFICATION_KINDS),
  payload: z.object({ lead_id: uuidSchema, reason: z.enum(UNASSIGNED_REASONS) }),
  read_at: z.string().nullable(),
  created_at: z.string(),
});
export type NotificationRow = z.infer<typeof notificationRowSchema>;

/** Résultat de `auto_assign_lead`. */
export const autoAssignResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("assigned"), assignee_id: uuidSchema }),
  z.object({ outcome: z.literal("unassigned"), reason: z.string() }),
  z.object({ outcome: z.literal("skipped"), reason: z.string() }),
]);
export type AutoAssignResult = z.infer<typeof autoAssignResultSchema>;
