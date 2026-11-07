import { z } from "zod";
import { uuidSchema } from "../tenant/schemas";
import { PLAN_CODES, SUBSCRIPTION_STATUSES, planLimitsSchema } from "./limits";

/**
 * Administration de la plateforme (J14) : activation et changement d'abonnement. L'organisation CIBLE est un champ
 * explicite (`target_organization_id`) : l'administrateur n'a pas d'organisation active, et le champ standard
 * `organization_id` reste interdit par le pipeline de service.
 */

/** La surcharge de limites arrive en JSON (champ caché ou saisie) : analysée puis validée, jamais crue. */
const limitsJson = z
  .string()
  .max(1024)
  .transform((raw, ctx) => {
    if (raw.trim() === "") return {};
    try {
      const parsed = planLimitsSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      /* JSON invalide : traité comme entrée invalide ci-dessous */
    }
    ctx.addIssue({ code: "custom", message: "invalid_limits" });
    return z.NEVER;
  });

export const setSubscriptionSchema = z
  .object({
    target_organization_id: uuidSchema,
    plan_code: z.enum(PLAN_CODES),
    status: z.enum(SUBSCRIPTION_STATUSES),
    limits_override: limitsJson,
    reason: z.string().trim().min(3).max(200),
    /** Date de fin de période (AAAA-MM-JJ), facultative. */
    period_end: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .or(z.literal("").transform(() => undefined)),
  })
  .strict();
export type SetSubscriptionInput = z.infer<typeof setSubscriptionSchema>;

/** Ligne de `admin_list_organizations`. */
export const adminOrganizationRowSchema = z.object({
  organization_id: uuidSchema,
  name: z.string(),
  slug: z.string(),
  org_status: z.string(),
  plan_code: z.string().nullable(),
  sub_status: z.enum(SUBSCRIPTION_STATUSES).nullable(),
  period_end: z.string().nullable(),
  limits_override: planLimitsSchema.nullable(),
  members: z.number().int().min(0),
  created_at: z.string(),
});
export type AdminOrganizationRow = z.infer<typeof adminOrganizationRowSchema>;
