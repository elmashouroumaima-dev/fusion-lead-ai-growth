import {
  assignLeadSchema,
  createDealSchema,
  moveDealStageSchema,
  moveLeadStageSchema,
  type AssignLeadInput,
  type CreateDealInput,
  type MoveDealStageInput,
  type MoveLeadStageInput,
} from "@fusion-leap/domain";
import { dueDateToIso } from "../activities/action-schemas";
import type { ServiceSchema } from "../service/with-service";
import { NO_ASSIGNEE } from "./form-options";

/**
 * Schémas des Server Actions de la fiche lead (J30d) : les champs de formulaire (tous des textes) deviennent les entrées des
 * schémas métier du domaine. `organization_id` n'est jamais une vérité : le pipeline le compare au contexte vérifié.
 */

type Raw = Record<string, string | undefined>;

type Parsed<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: ReadonlyArray<{ code: string; path: PropertyKey[] }> } };

function through<T>(build: (raw: Raw) => unknown, schema: { safeParse(input: unknown): Parsed<T> }): ServiceSchema<T> {
  return { safeParse: (raw) => schema.safeParse(build(raw as Raw)) };
}

const blankToUndefined = (value: string | undefined): string | undefined => (value === undefined || value.trim() === "" ? undefined : value);

/** Valeur saisie : entier ou décimal à 2 chiffres au plus (virgule ou point). Tout autre texte est transmis tel quel et refusé. */
export function parseDealValue(value: string | undefined): number | string | undefined {
  const text = blankToUndefined(value)?.trim();
  if (text === undefined) return undefined;
  return /^\d{1,12}([.,]\d{1,2})?$/.test(text) ? Number(text.replace(",", ".")) : text;
}

export const moveLeadStageFormSchema: ServiceSchema<MoveLeadStageInput> = through(
  (r) => ({ lead_id: r.lead_id, stage_id: r.stage_id, organization_id: blankToUndefined(r.organization_id) }),
  moveLeadStageSchema,
);

/** « Aucun responsable » : valeur vide, le lead retourne dans la file des non assignés (règle de la base). */
export const assignLeadFormSchema: ServiceSchema<AssignLeadInput> = through(
  (r) => ({ lead_id: r.lead_id, assignee_id: r.assignee_id === NO_ASSIGNEE ? null : (blankToUndefined(r.assignee_id) ?? null), organization_id: blankToUndefined(r.organization_id) }),
  assignLeadSchema,
);

export const createDealFormSchema: ServiceSchema<CreateDealInput> = through(
  (r) => ({
    lead_id: r.lead_id,
    stage_id: blankToUndefined(r.stage_id) ?? null,
    value: parseDealValue(r.value),
    currency: blankToUndefined(r.currency),
    expected_close_at: dueDateToIso(r.expected_close_date) ?? null,
    organization_id: blankToUndefined(r.organization_id),
  }),
  createDealSchema,
);

export const moveDealStageFormSchema: ServiceSchema<MoveDealStageInput> = through(
  (r) => ({ deal_id: r.deal_id, stage_id: r.stage_id, organization_id: blankToUndefined(r.organization_id) }),
  moveDealStageSchema,
);

export const LEAD_STAGE_FIELDS = ["lead_id", "stage_id", "organization_id"] as const;
export const LEAD_ASSIGN_FIELDS = ["lead_id", "assignee_id", "organization_id"] as const;
export const DEAL_CREATE_FIELDS = ["lead_id", "stage_id", "value", "currency", "expected_close_date", "organization_id"] as const;
export const DEAL_STAGE_FIELDS = ["deal_id", "stage_id", "organization_id"] as const;
