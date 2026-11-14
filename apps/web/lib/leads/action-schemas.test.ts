import { describe, expect, it } from "vitest";
import { toActionCode } from "./action-code";
import {
  DEAL_CREATE_FIELDS,
  DEAL_STAGE_FIELDS,
  LEAD_ASSIGN_FIELDS,
  LEAD_STAGE_FIELDS,
  assignLeadFormSchema,
  createDealFormSchema,
  moveDealStageFormSchema,
  moveLeadStageFormSchema,
  parseDealValue,
} from "./action-schemas";
import { DEAL_CURRENCIES, DEFAULT_DEAL_CURRENCY, NO_ASSIGNEE } from "./form-options";

const LEAD = "11111111-1111-4111-8111-111111111111";
const STAGE = "44444444-4444-4444-8444-444444444444";
const DEAL = "55555555-5555-4555-8555-555555555555";
const MEMBER = "66666666-6666-4666-8666-666666666666";
const ORG = "22222222-2222-4222-8222-222222222222";

describe("parseDealValue", () => {
  it("accepte un entier ou un décimal à 2 chiffres (point ou virgule) ; le reste passe tel quel et sera refusé", () => {
    expect(parseDealValue("1500")).toBe(1500);
    expect(parseDealValue("1500.5")).toBe(1500.5);
    expect(parseDealValue("1500,75")).toBe(1500.75);
    expect(parseDealValue(" 12 ")).toBe(12);
    expect(parseDealValue("")).toBeUndefined();
    expect(parseDealValue(undefined)).toBeUndefined();
    expect(parseDealValue("1 500")).toBe("1 500");
    expect(parseDealValue("12.345")).toBe("12.345");
    expect(parseDealValue("-5")).toBe("-5");
  });
});

describe("createDealFormSchema", () => {
  const base = { lead_id: LEAD, organization_id: ORG, currency: "MAD" };

  it("valeur, devise, clôture prévue (date -> midi UTC) et étape facultative", () => {
    const ok = createDealFormSchema.safeParse({ ...base, value: "2000", stage_id: STAGE, expected_close_date: "2027-01-31" });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.value).toBe(2000);
      expect(ok.data.stage_id).toBe(STAGE);
      expect(ok.data.expected_close_at).toBe("2027-01-31T12:00:00Z");
    }
    const bare = createDealFormSchema.safeParse({ ...base, value: "10" });
    expect(bare.success).toBe(true);
    if (bare.success) expect(bare.data.stage_id).toBeNull();
  });

  it("refuse une valeur absente, négative ou illisible, une devise invalide, un lead invalide et une date invalide", () => {
    expect(createDealFormSchema.safeParse({ ...base }).success).toBe(false);
    expect(createDealFormSchema.safeParse({ ...base, value: "-1" }).success).toBe(false);
    expect(createDealFormSchema.safeParse({ ...base, value: "abc" }).success).toBe(false);
    expect(createDealFormSchema.safeParse({ ...base, value: "10", currency: "mad" }).success).toBe(false);
    expect(createDealFormSchema.safeParse({ ...base, value: "10", currency: undefined }).success).toBe(false);
    expect(createDealFormSchema.safeParse({ ...base, value: "10", lead_id: "x" }).success).toBe(false);
    expect(createDealFormSchema.safeParse({ ...base, value: "10", expected_close_date: "demain" }).success).toBe(false);
  });

  it("les devises proposées sont des codes de 3 lettres majuscules et incluent la devise par défaut", () => {
    for (const code of DEAL_CURRENCIES) expect(code).toMatch(/^[A-Z]{3}$/);
    expect(DEAL_CURRENCIES).toContain(DEFAULT_DEAL_CURRENCY);
  });
});

describe("assignLeadFormSchema", () => {
  it("un membre est assigné ; « aucun responsable » (valeur du menu ou vide) donne null ; un identifiant invalide est refusé", () => {
    const member = assignLeadFormSchema.safeParse({ lead_id: LEAD, assignee_id: MEMBER });
    expect(member.success && member.data.assignee_id).toBe(MEMBER);
    for (const value of [NO_ASSIGNEE, "", undefined]) {
      const none = assignLeadFormSchema.safeParse({ lead_id: LEAD, assignee_id: value });
      expect(none.success && none.data.assignee_id).toBeNull();
    }
    expect(assignLeadFormSchema.safeParse({ lead_id: LEAD, assignee_id: "pas-un-uuid" }).success).toBe(false);
  });
});

describe("moveLeadStageFormSchema et moveDealStageFormSchema", () => {
  it("exigent l'objet et l'étape (UUID)", () => {
    expect(moveLeadStageFormSchema.safeParse({ lead_id: LEAD, stage_id: STAGE }).success).toBe(true);
    expect(moveLeadStageFormSchema.safeParse({ lead_id: LEAD }).success).toBe(false);
    expect(moveDealStageFormSchema.safeParse({ deal_id: DEAL, stage_id: STAGE }).success).toBe(true);
    expect(moveDealStageFormSchema.safeParse({ deal_id: "x", stage_id: STAGE }).success).toBe(false);
  });
});

describe("listes fermées de champs", () => {
  it("chaque action lit l'organisation pour la COMPARER au contexte, et jamais un responsable, une date de gain ou une valeur libre non prévue", () => {
    for (const fields of [LEAD_STAGE_FIELDS, LEAD_ASSIGN_FIELDS, DEAL_CREATE_FIELDS, DEAL_STAGE_FIELDS]) {
      expect(fields).toContain("organization_id");
    }
    for (const forbidden of ["won_at", "lost_at", "owner_id", "assignee"]) {
      for (const fields of [LEAD_STAGE_FIELDS, DEAL_CREATE_FIELDS, DEAL_STAGE_FIELDS]) expect(fields as readonly string[]).not.toContain(forbidden);
    }
  });
});

describe("toActionCode", () => {
  it("traduit les codes de la couche service en codes d'état de formulaire", () => {
    expect(toActionCode("validation_failed")).toBe("invalid_input");
    expect(toActionCode("forbidden")).toBe("forbidden");
    expect(toActionCode("conflict")).toBe("conflict");
    expect(toActionCode("quota_exceeded")).toBe("quota_exceeded");
    expect(toActionCode("internal_error")).toBe("generic");
  });
});
