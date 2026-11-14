import { describe, expect, it } from "vitest";
import { toActionCode } from "./action-code";
import {
  ACTIVITY_CREATE_FIELDS,
  TASK_COMPLETE_FIELDS,
  completeTaskFormSchema,
  createActivityFormSchema,
  dueDateToIso,
} from "./action-schemas";

const LEAD = "11111111-1111-4111-8111-111111111111";
const ACTIVITY = "33333333-3333-4333-8333-333333333333";
const ORG = "22222222-2222-4222-8222-222222222222";

describe("dueDateToIso", () => {
  it("une date AAAA-MM-JJ devient midi UTC ; vide ou absente = pas d'échéance ; le reste passe tel quel (et sera refusé)", () => {
    expect(dueDateToIso("2026-12-24")).toBe("2026-12-24T12:00:00Z");
    expect(dueDateToIso("")).toBeUndefined();
    expect(dueDateToIso("   ")).toBeUndefined();
    expect(dueDateToIso(undefined)).toBeUndefined();
    expect(dueDateToIso("demain")).toBe("demain");
  });
});

describe("createActivityFormSchema", () => {
  const base = { lead_id: LEAD, organization_id: ORG };

  it("note : le texte est obligatoire", () => {
    const ok = createActivityFormSchema.safeParse({ ...base, type: "note", text: "Rappeler lundi" });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.metadata).toEqual({ text: "Rappeler lundi" });
    expect(createActivityFormSchema.safeParse({ ...base, type: "note", text: "   " }).success).toBe(false);
    expect(createActivityFormSchema.safeParse({ ...base, type: "note" }).success).toBe(false);
  });

  it("appel : résultat, durée et texte facultatifs ; une durée illisible ou hors bornes est refusée", () => {
    const ok = createActivityFormSchema.safeParse({ ...base, type: "call", outcome: "answered", duration_minutes: "12", text: "RAS" });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.metadata).toEqual({ outcome: "answered", duration_minutes: 12, text: "RAS" });
    // un appel sans résultat ni texte ne dit rien : refusé par le domaine (l'écran envoie toujours un résultat)
    expect(createActivityFormSchema.safeParse({ ...base, type: "call" }).success).toBe(false);
    expect(createActivityFormSchema.safeParse({ ...base, type: "call", outcome: "busy" }).success).toBe(true);
    expect(createActivityFormSchema.safeParse({ ...base, type: "call", duration_minutes: "abc" }).success).toBe(false);
    expect(createActivityFormSchema.safeParse({ ...base, type: "call", duration_minutes: "9999" }).success).toBe(false);
    expect(createActivityFormSchema.safeParse({ ...base, type: "call", outcome: "ghosted" }).success).toBe(false);
  });

  it("tâche : titre obligatoire, échéance facultative (date), texte facultatif", () => {
    const ok = createActivityFormSchema.safeParse({ ...base, type: "task", title: "Envoyer le devis", due_date: "2026-12-30", text: "PDF" });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.metadata).toEqual({ title: "Envoyer le devis", text: "PDF" });
      expect(ok.data.due_at).toBe("2026-12-30T12:00:00Z");
    }
    expect(createActivityFormSchema.safeParse({ ...base, type: "task", title: "" }).success).toBe(false);
    expect(createActivityFormSchema.safeParse({ ...base, type: "task", title: "x", due_date: "demain" }).success).toBe(false);
  });

  it("les types automatiques ou non proposés par l'écran (étape, assignation, e-mail, rendez-vous) sont refusés", () => {
    for (const type of ["stage_change", "assignment", "email", "meeting", "", undefined]) {
      expect(createActivityFormSchema.safeParse({ ...base, type, text: "x", title: "x" }).success, String(type)).toBe(false);
    }
  });

  it("l'identifiant du lead doit être un UUID ; l'organisation n'est lue que pour être comparée au contexte", () => {
    expect(createActivityFormSchema.safeParse({ ...base, lead_id: "pas-un-uuid", type: "note", text: "x" }).success).toBe(false);
    expect(ACTIVITY_CREATE_FIELDS).toContain("organization_id");
    expect(ACTIVITY_CREATE_FIELDS).not.toContain("owner_id");
    expect(ACTIVITY_CREATE_FIELDS).not.toContain("metadata");
  });
});

describe("completeTaskFormSchema", () => {
  it("seule la valeur « true » marque la tâche faite ; l'identifiant doit être un UUID", () => {
    const done = completeTaskFormSchema.safeParse({ activity_id: ACTIVITY, done: "true" });
    const reopen = completeTaskFormSchema.safeParse({ activity_id: ACTIVITY, done: "false" });
    expect(done.success && done.data.done).toBe(true);
    expect(reopen.success && reopen.data.done).toBe(false);
    expect(completeTaskFormSchema.safeParse({ activity_id: "x", done: "true" }).success).toBe(false);
    expect(TASK_COMPLETE_FIELDS).toContain("organization_id");
  });
});

describe("toActionCode", () => {
  it("traduit les codes de la couche service en codes d'état de formulaire", () => {
    expect(toActionCode("validation_failed")).toBe("invalid_input");
    expect(toActionCode("unauthenticated")).toBe("forbidden");
    expect(toActionCode("quota_exceeded")).toBe("quota_exceeded");
    expect(toActionCode("conflict")).toBe("conflict");
    expect(toActionCode("internal_error")).toBe("generic");
  });
});
