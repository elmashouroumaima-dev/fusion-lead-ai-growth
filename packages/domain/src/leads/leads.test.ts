import { describe, expect, it } from "vitest";
import {
  assignLeadSchema,
  closedDatesFor,
  createDealSchema,
  createLeadSchema,
  createStageSchema,
  initialStageFor,
  moveDealStageSchema,
  sortStages,
  stageMatchesAssignee,
  updateDealSchema,
  updateLeadSchema,
  updateStageSchema,
  type PipelineStageRow,
} from "./index";

const UUID = (n: number) => `7a000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = UUID(1);
const NOW = "2026-11-21T10:00:00+00:00";

const stage = (n: number, kind: PipelineStageRow["kind"], position: number): PipelineStageRow => ({
  id: UUID(100 + n), organization_id: ORG, pipeline_id: UUID(50), name: `E${n}`, position, kind, created_at: NOW, updated_at: NOW,
});

describe("closedDatesFor", () => {
  const now = new Date("2026-11-21T10:00:00Z");
  it("gagné, perdu, ouvert : les dates suivent le genre de l'étape", () => {
    expect(closedDatesFor("won", now)).toEqual({ won_at: now.toISOString(), lost_at: null });
    expect(closedDatesFor("lost", now)).toEqual({ won_at: null, lost_at: now.toISOString() });
    expect(closedDatesFor("open", now)).toEqual({ won_at: null, lost_at: null });
  });
  it("l'étape système n'accepte aucun deal", () => {
    expect(closedDatesFor("unassigned", now)).toBeNull();
  });
});

describe("initialStageFor / stageMatchesAssignee / sortStages", () => {
  const stages = [stage(5, "lost", 50), stage(2, "open", 10), stage(1, "unassigned", 0), stage(3, "open", 20), stage(4, "won", 40)];

  it("sans responsable : l'étape système ; avec responsable : la première étape ouverte (ordre d'affichage)", () => {
    expect(initialStageFor(stages, null)?.kind).toBe("unassigned");
    expect(initialStageFor(stages, UUID(9))?.id).toBe(UUID(102));
  });

  it("pipeline sans l'étape voulue : null", () => {
    expect(initialStageFor(stages.filter((s) => s.kind !== "unassigned"), null)).toBeNull();
    expect(initialStageFor(stages.filter((s) => s.kind !== "open"), UUID(9))).toBeNull();
  });

  it("le tri est stable : position puis identifiant", () => {
    const tied = [stage(9, "open", 10), stage(2, "open", 10), stage(1, "unassigned", 0)];
    expect(sortStages(tied).map((s) => s.id)).toEqual([UUID(101), UUID(102), UUID(109)]);
  });

  it("l'étape « non assigné » exclut tout responsable", () => {
    expect(stageMatchesAssignee("unassigned", null)).toBe(true);
    expect(stageMatchesAssignee("unassigned", UUID(9))).toBe(false);
    expect(stageMatchesAssignee("open", UUID(9))).toBe(true);
    expect(stageMatchesAssignee("won", null)).toBe(true);
  });
});

describe("schémas des étapes", () => {
  it("un genre d'étape se choisit parmi open, won, lost (jamais unassigned)", () => {
    expect(createStageSchema.safeParse({ pipeline_id: UUID(50), name: "Négociation", kind: "open" }).success).toBe(true);
    expect(createStageSchema.safeParse({ pipeline_id: UUID(50), name: "Négociation", kind: "unassigned" }).success).toBe(false);
    expect(createStageSchema.safeParse({ pipeline_id: UUID(50), name: "", kind: "open" }).success).toBe(false);
    expect(createStageSchema.safeParse({ pipeline_id: UUID(50), name: "x", kind: "open", position: -1 }).success).toBe(false);
    expect(updateStageSchema.safeParse({ stage_id: UUID(1), name: "Renommée", position: 15 }).success).toBe(true);
    expect(updateStageSchema.safeParse({ stage_id: UUID(1), name: "Renommée", position: 1.5 }).success).toBe(false);
  });
});

describe("schémas des leads", () => {
  const base = { contact_id: UUID(2), project_id: UUID(3), source: "web_form" };

  it("lead minimal valide ; source en code court", () => {
    expect(createLeadSchema.safeParse(base).success).toBe(true);
    expect(createLeadSchema.safeParse({ ...base, source: "Web Form" }).success).toBe(false);
    expect(createLeadSchema.safeParse({ ...base, source: "" }).success).toBe(false);
  });

  it("score entier de 0 à 100 ; UTM : clés connues et textes courts seulement", () => {
    expect(createLeadSchema.safeParse({ ...base, score: 100 }).success).toBe(true);
    expect(createLeadSchema.safeParse({ ...base, score: 101 }).success).toBe(false);
    expect(createLeadSchema.safeParse({ ...base, score: 4.5 }).success).toBe(false);
    expect(createLeadSchema.safeParse({ ...base, utm: { utm_source: "newsletter", landing_page_id: "lp-1" } }).success).toBe(true);
    expect(createLeadSchema.safeParse({ ...base, utm: { cookie: "x" } }).success).toBe(false);
    expect(createLeadSchema.safeParse({ ...base, utm: { utm_source: "a؜b" } }).success).toBe(false);
  });

  it("raisons du score bornées à 4 Ko", () => {
    expect(createLeadSchema.safeParse({ ...base, score_reason: { raison: "budget" } }).success).toBe(true);
    expect(createLeadSchema.safeParse({ ...base, score_reason: { raison: "x".repeat(5000) } }).success).toBe(false);
  });

  it("identifiant externe : source et identifiant vont ensemble côté base ; vides = absents", () => {
    const parsed = createLeadSchema.safeParse({ ...base, external_source: " ", external_id: "" });
    expect(parsed.success && parsed.data.external_source).toBeNull();
  });

  it("modification, assignation (responsable nul accepté)", () => {
    expect(updateLeadSchema.safeParse({ lead_id: UUID(4), source: "manual", score: null }).success).toBe(true);
    expect(updateLeadSchema.safeParse({ source: "manual" }).success).toBe(false);
    expect(assignLeadSchema.safeParse({ lead_id: UUID(4), assignee_id: null }).success).toBe(true);
    expect(assignLeadSchema.safeParse({ lead_id: UUID(4) }).success).toBe(false);
    expect(assignLeadSchema.safeParse({ lead_id: UUID(4), assignee_id: "pas-un-uuid" }).success).toBe(false);
  });

  it("organization_id revendiqué est conservé pour comparaison, jamais utilisé comme source", () => {
    const parsed = createLeadSchema.safeParse({ ...base, organization_id: ORG });
    expect(parsed.success && parsed.data.organization_id).toBe(ORG);
    expect(createLeadSchema.safeParse({ ...base, organization_id: "x" }).success).toBe(false);
  });
});

describe("schémas des deals", () => {
  const base = { lead_id: UUID(4), value: 1500.5, currency: "MAD" };

  it("deal valide ; valeur positive à deux décimales ; devise ISO en majuscules", () => {
    expect(createDealSchema.safeParse(base).success).toBe(true);
    expect(createDealSchema.safeParse({ ...base, value: 0 }).success).toBe(true);
    expect(createDealSchema.safeParse({ ...base, value: -1 }).success).toBe(false);
    expect(createDealSchema.safeParse({ ...base, value: 10.123 }).success).toBe(false);
    expect(createDealSchema.safeParse({ ...base, value: 1e13 }).success).toBe(false);
    expect(createDealSchema.safeParse({ ...base, currency: "mad" }).success).toBe(false);
    expect(createDealSchema.safeParse({ ...base, currency: "DIRHAM" }).success).toBe(false);
  });

  it("date d'échéance ISO avec fuseau ; vide = absente ; étape facultative", () => {
    expect(createDealSchema.safeParse({ ...base, expected_close_at: "2026-12-31T00:00:00Z" }).success).toBe(true);
    expect(createDealSchema.safeParse({ ...base, expected_close_at: "demain" }).success).toBe(false);
    const empty = createDealSchema.safeParse({ ...base, expected_close_at: "" });
    expect(empty.success && empty.data.expected_close_at).toBeNull();
    expect(createDealSchema.safeParse({ ...base, stage_id: UUID(7) }).success).toBe(true);
  });

  it("modification et changement d'étape", () => {
    expect(updateDealSchema.safeParse({ deal_id: UUID(6), value: 20, currency: "SAR" }).success).toBe(true);
    expect(moveDealStageSchema.safeParse({ deal_id: UUID(6), stage_id: UUID(7) }).success).toBe(true);
    expect(moveDealStageSchema.safeParse({ deal_id: UUID(6) }).success).toBe(false);
  });
});
