import { z } from "zod";

/**
 * Plans et quotas (J14, ADR 007 G-D1 / E6, spec §10). Miroir TypeScript de la migration
 * `20261116100000_plans_quotas.sql` (la parité est vérifiée par un test).
 */

/** Métriques « flux » : compteur mensuel atomique (`usage_counters`). */
export const FLOW_METRICS = ["messages_per_month", "ai_runs"] as const;
/** Métriques « stock » : usage = lignes existantes (membres + invitations, projets, contacts, intégrations). */
export const STOCK_METRICS = ["users", "projects", "contacts", "integrations"] as const;
export const PLAN_METRICS = [...STOCK_METRICS, ...FLOW_METRICS] as const;
export type PlanMetric = (typeof PLAN_METRICS)[number];

export const PLAN_CODES = ["trial", "starter", "growth"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export const SUBSCRIPTION_STATUSES = ["trial", "active", "past_due", "suspended", "cancelled"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Seuil de l'alerte avant blocage (pourcentage de la limite). Miroir de `near_limit` en SQL. */
export const NEAR_LIMIT_PERCENT = 80;

const limitValue = z.number().int().min(0).max(999_999_999_999);

/** Limites d'un plan ou surcharge d'un abonnement : clés connues seulement, entiers ≥ 0. Clé absente = pas de limite. */
export const planLimitsSchema = z
  .object({
    users: limitValue,
    projects: limitValue,
    contacts: limitValue,
    messages_per_month: limitValue,
    ai_runs: limitValue,
    integrations: limitValue,
  })
  .partial()
  .strict();
export type PlanLimits = z.infer<typeof planLimitsSchema>;

/**
 * Catalogue provisoire (la spec ne donne aucune valeur ; à valider par la responsable technique).
 * Source de vérité : la table `plans` ; ces constantes servent à l'interface et aux tests de parité.
 */
export const PLAN_CATALOG: Readonly<Record<PlanCode, Readonly<Required<PlanLimits>>>> = {
  trial: { users: 3, projects: 1, contacts: 500, messages_per_month: 200, ai_runs: 50, integrations: 2 },
  starter: { users: 5, projects: 3, contacts: 5000, messages_per_month: 2000, ai_runs: 200, integrations: 3 },
  growth: { users: 15, projects: 10, contacts: 50000, messages_per_month: 20000, ai_runs: 2000, integrations: 6 },
};

/** Limite effective : la surcharge de l'abonnement l'emporte sur le plan ; `null` = aucune limite. */
export function effectiveLimit(plan: PlanLimits, override: PlanLimits, metric: PlanMetric): number | null {
  return override[metric] ?? plan[metric] ?? null;
}

export type LimitCheck = {
  allowed: boolean;
  used: number;
  limit: number | null;
  remaining: number | null;
  /** Usage ≥ 80 % de la limite (alerte avant blocage). */
  nearLimit: boolean;
};

/**
 * Contrôle pur d'une consommation de `amount` sur un usage courant. Même règle que
 * `private.assert_within_limit` : autorisé si `used + amount <= limit` (ou si aucune limite).
 * `used` et `remaining` décrivent l'état APRÈS la consommation quand elle est autorisée.
 */
export function assertWithinLimit(input: { used: number; limit: number | null; amount?: number }): LimitCheck {
  const amount = input.amount ?? 1;
  if (!Number.isInteger(amount) || amount < 1 || !Number.isInteger(input.used) || input.used < 0) {
    throw new RangeError("invalid_quota_input");
  }
  const { limit } = input;
  const allowed = limit === null || input.used + amount <= limit;
  const used = allowed ? input.used + amount : input.used;
  return {
    allowed,
    used,
    limit,
    remaining: limit === null ? null : Math.max(limit - used, 0),
    nearLimit: limit !== null && limit > 0 && used * 100 >= limit * NEAR_LIMIT_PERCENT,
  };
}

/** Ligne d'usage renvoyée par `get_org_usage`. */
export const usageRowSchema = z.object({
  metric: z.enum(PLAN_METRICS),
  used: z.number().int().min(0),
  limit: z.number().int().min(0).nullable(),
  near_limit: z.boolean(),
});
export type UsageRow = z.infer<typeof usageRowSchema>;
