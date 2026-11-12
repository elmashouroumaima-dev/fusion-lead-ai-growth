import { describe, expect, it } from "vitest";
import {
  autoAssignResultSchema,
  createAssignmentRuleSchema,
  notificationRowSchema,
  updateAssignmentRuleSchema,
} from "./index";

const UUID = (n: number) => `7b000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("createAssignmentRuleSchema", () => {
  it("round-robin avec plusieurs membres ; project_id absent = règle par défaut", () => {
    const parsed = createAssignmentRuleSchema.safeParse({ strategy: "round_robin", eligible_member_ids: [UUID(1), UUID(2)] });
    expect(parsed.success && parsed.data.project_id).toBe(null);
    expect(createAssignmentRuleSchema.safeParse({ project_id: UUID(9), strategy: "round_robin", eligible_member_ids: [UUID(1)] }).success).toBe(true);
  });

  it("fixed : exactement un membre", () => {
    expect(createAssignmentRuleSchema.safeParse({ strategy: "fixed", eligible_member_ids: [UUID(1)] }).success).toBe(true);
    expect(createAssignmentRuleSchema.safeParse({ strategy: "fixed", eligible_member_ids: [UUID(1), UUID(2)] }).success).toBe(false);
  });

  it("refuse liste vide, doublons, plus de 50 membres, stratégie inconnue, champ inconnu (dont organization_id)", () => {
    expect(createAssignmentRuleSchema.safeParse({ strategy: "round_robin", eligible_member_ids: [] }).success).toBe(false);
    expect(createAssignmentRuleSchema.safeParse({ strategy: "round_robin", eligible_member_ids: [UUID(1), UUID(1)] }).success).toBe(false);
    expect(createAssignmentRuleSchema.safeParse({ strategy: "round_robin", eligible_member_ids: Array.from({ length: 51 }, (_, i) => UUID(i + 1)) }).success).toBe(false);
    expect(createAssignmentRuleSchema.safeParse({ strategy: "random", eligible_member_ids: [UUID(1)] }).success).toBe(false);
    expect(createAssignmentRuleSchema.safeParse({ strategy: "fixed", eligible_member_ids: [UUID(1)], organization_id: UUID(5) }).success).toBe(false);
    expect(createAssignmentRuleSchema.safeParse({ strategy: "fixed", eligible_member_ids: ["pas-un-uuid"] }).success).toBe(false);
  });
});

describe("updateAssignmentRuleSchema", () => {
  it("identifiant de règle, état et membres obligatoires", () => {
    expect(updateAssignmentRuleSchema.safeParse({ rule_id: UUID(1), strategy: "round_robin", eligible_member_ids: [UUID(2)], active: false }).success).toBe(true);
    expect(updateAssignmentRuleSchema.safeParse({ rule_id: UUID(1), strategy: "round_robin", eligible_member_ids: [UUID(2)] }).success).toBe(false);
    expect(updateAssignmentRuleSchema.safeParse({ rule_id: UUID(1), strategy: "fixed", eligible_member_ids: [UUID(2), UUID(3)], active: true }).success).toBe(false);
  });
});

describe("notifications et résultat d'assignation", () => {
  it("la charge utile d'une notification ne contient que lead_id et un motif connu", () => {
    const row = { id: UUID(1), organization_id: UUID(2), recipient_id: UUID(3), kind: "lead.unassigned", read_at: null, created_at: "2026-11-08T00:00:00Z" };
    expect(notificationRowSchema.safeParse({ ...row, payload: { lead_id: UUID(4), reason: "no_rule" } }).success).toBe(true);
    expect(notificationRowSchema.safeParse({ ...row, payload: { lead_id: UUID(4), reason: "autre" } }).success).toBe(false);
    expect(notificationRowSchema.safeParse({ ...row, kind: "autre", payload: { lead_id: UUID(4), reason: "no_rule" } }).success).toBe(false);
  });

  it("résultat : assigned avec responsable, unassigned / skipped avec motif", () => {
    expect(autoAssignResultSchema.safeParse({ outcome: "assigned", assignee_id: UUID(1) }).success).toBe(true);
    expect(autoAssignResultSchema.safeParse({ outcome: "assigned" }).success).toBe(false);
    expect(autoAssignResultSchema.safeParse({ outcome: "unassigned", reason: "no_rule" }).success).toBe(true);
    expect(autoAssignResultSchema.safeParse({ outcome: "skipped", reason: "not_unassigned" }).success).toBe(true);
    expect(autoAssignResultSchema.safeParse({ outcome: "?" }).success).toBe(false);
  });
});
