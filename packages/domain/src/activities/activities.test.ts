import { describe, expect, it } from "vitest";
import {
  completeTaskSchema,
  createActivitySchema,
  dueTasks,
  isDue,
  isOpenTask,
  nextAction,
  sortTimeline,
  updateTaskSchema,
  type ActivityRow,
} from "./index";

const UUID = (n: number) => `7a000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = UUID(1);
const LEAD = UUID(2);

const activity = (n: number, over: Partial<ActivityRow> = {}): ActivityRow => ({
  id: UUID(100 + n), organization_id: ORG, lead_id: LEAD, contact_id: UUID(3), type: "task", owner_id: UUID(4), due_at: null, completed_at: null,
  metadata: { title: `T${n}` }, created_at: `2026-11-22T10:00:0${n}+00:00`, updated_at: `2026-11-22T10:00:0${n}+00:00`, ...over,
});

describe("createActivitySchema : contenu par type", () => {
  const base = { lead_id: LEAD };

  it("note : texte obligatoire, 2000 caractères au plus, aucune clé inconnue", () => {
    expect(createActivitySchema.safeParse({ ...base, type: "note", metadata: { text: "Premier contact" } }).success).toBe(true);
    expect(createActivitySchema.safeParse({ ...base, type: "note", metadata: {} }).success).toBe(false);
    expect(createActivitySchema.safeParse({ ...base, type: "note", metadata: { text: "x".repeat(2001) } }).success).toBe(false);
    expect(createActivitySchema.safeParse({ ...base, type: "note", metadata: { text: "x", autre: 1 } }).success).toBe(false);
    expect(createActivitySchema.safeParse({ ...base, type: "note", metadata: { text: "a؜b" } }).success).toBe(false);
  });

  it("appel : texte ou issue ; durée entière de 0 à 600 minutes", () => {
    expect(createActivitySchema.safeParse({ ...base, type: "call", metadata: { outcome: "no_answer" } }).success).toBe(true);
    expect(createActivitySchema.safeParse({ ...base, type: "call", metadata: { text: "Intéressé", duration_minutes: 12 } }).success).toBe(true);
    expect(createActivitySchema.safeParse({ ...base, type: "call", metadata: { duration_minutes: 5 } }).success).toBe(false);
    expect(createActivitySchema.safeParse({ ...base, type: "call", metadata: { outcome: "inconnue" } }).success).toBe(false);
    expect(createActivitySchema.safeParse({ ...base, type: "call", metadata: { outcome: "busy", duration_minutes: 601 } }).success).toBe(false);
    expect(createActivitySchema.safeParse({ ...base, type: "call", metadata: { outcome: "busy", duration_minutes: 1.5 } }).success).toBe(false);
  });

  it("e-mail : objet obligatoire ; rendez-vous et tâche : titre obligatoire", () => {
    expect(createActivitySchema.safeParse({ ...base, type: "email", metadata: { subject: "Offre", text: "Compte rendu" } }).success).toBe(true);
    expect(createActivitySchema.safeParse({ ...base, type: "email", metadata: { text: "sans objet" } }).success).toBe(false);
    expect(createActivitySchema.safeParse({ ...base, type: "meeting", metadata: { title: "Démo" } }).success).toBe(true);
    expect(createActivitySchema.safeParse({ ...base, type: "task", metadata: { text: "sans titre" } }).success).toBe(false);
  });

  it("stage_change et assignment ne se créent pas à la main", () => {
    expect(createActivitySchema.safeParse({ ...base, type: "stage_change", metadata: {} }).success).toBe(false);
    expect(createActivitySchema.safeParse({ ...base, type: "assignment", metadata: {} }).success).toBe(false);
  });

  it("échéance : tâche et rendez-vous seulement, ISO avec fuseau ; responsable : tâche seulement", () => {
    expect(createActivitySchema.safeParse({ ...base, type: "task", metadata: { title: "x" }, due_at: "2026-12-10T09:00:00Z" }).success).toBe(true);
    expect(createActivitySchema.safeParse({ ...base, type: "meeting", metadata: { title: "x" }, due_at: "2026-12-10T09:00:00+01:00" }).success).toBe(true);
    expect(createActivitySchema.safeParse({ ...base, type: "note", metadata: { text: "x" }, due_at: "2026-12-10T09:00:00Z" }).success).toBe(false);
    expect(createActivitySchema.safeParse({ ...base, type: "task", metadata: { title: "x" }, due_at: "demain" }).success).toBe(false);
    const empty = createActivitySchema.safeParse({ ...base, type: "task", metadata: { title: "x" }, due_at: "" });
    expect(empty.success && empty.data.due_at).toBeNull();
    expect(createActivitySchema.safeParse({ ...base, type: "task", metadata: { title: "x" }, owner_id: UUID(5) }).success).toBe(true);
    expect(createActivitySchema.safeParse({ ...base, type: "note", metadata: { text: "x" }, owner_id: UUID(5) }).success).toBe(false);
  });

  it("organization_id revendiqué est conservé pour comparaison, jamais utilisé comme source", () => {
    const parsed = createActivitySchema.safeParse({ ...base, type: "note", metadata: { text: "x" }, organization_id: ORG });
    expect(parsed.success && parsed.data.organization_id).toBe(ORG);
    expect(createActivitySchema.safeParse({ ...base, type: "note", metadata: { text: "x" }, organization_id: "x" }).success).toBe(false);
  });
});

describe("tâches : modification et fin", () => {
  it("updateTaskSchema exige l'identifiant et un contenu de tâche", () => {
    expect(updateTaskSchema.safeParse({ activity_id: UUID(9), metadata: { title: "Relancer" }, due_at: null }).success).toBe(true);
    expect(updateTaskSchema.safeParse({ activity_id: UUID(9), metadata: { title: "Relancer" }, due_at: "2026-12-12T09:00:00Z" }).success).toBe(true);
    // omettre l'échéance ne l'efface jamais en silence : elle est obligatoire (nulle = la retirer)
    expect(updateTaskSchema.safeParse({ activity_id: UUID(9), metadata: { title: "Relancer" } }).success).toBe(false);
    expect(updateTaskSchema.safeParse({ metadata: { title: "Relancer" }, due_at: null }).success).toBe(false);
    expect(updateTaskSchema.safeParse({ activity_id: UUID(9), metadata: { text: "sans titre" }, due_at: null }).success).toBe(false);
  });

  it("completeTaskSchema : booléen obligatoire", () => {
    expect(completeTaskSchema.safeParse({ activity_id: UUID(9), done: true }).success).toBe(true);
    expect(completeTaskSchema.safeParse({ activity_id: UUID(9) }).success).toBe(false);
    expect(completeTaskSchema.safeParse({ activity_id: UUID(9), done: "oui" }).success).toBe(false);
  });
});

describe("chronologie et prochaine action", () => {
  const now = new Date("2026-12-11T00:00:00Z");

  it("isOpenTask / isDue : seule une tâche non terminée avec échéance atteinte est due", () => {
    expect(isOpenTask(activity(1))).toBe(true);
    expect(isOpenTask(activity(1, { completed_at: "2026-12-01T00:00:00Z" }))).toBe(false);
    expect(isOpenTask(activity(1, { type: "note" }))).toBe(false);
    expect(isDue(activity(1, { due_at: "2026-12-10T09:00:00Z" }), now)).toBe(true);
    expect(isDue(activity(1, { due_at: "2026-12-12T09:00:00Z" }), now)).toBe(false);
    expect(isDue(activity(1), now)).toBe(false);
    expect(isDue(activity(1, { due_at: "2026-12-10T09:00:00Z", completed_at: "2026-12-10T10:00:00Z" }), now)).toBe(false);
  });

  it("nextAction : échéance la plus proche d'abord, sans échéance en dernier, tâches terminées ignorées", () => {
    const list = [
      activity(1, { due_at: null }),
      activity(2, { due_at: "2026-12-20T09:00:00Z" }),
      activity(3, { due_at: "2026-12-12T09:00:00Z" }),
      activity(4, { due_at: "2026-12-01T09:00:00Z", completed_at: "2026-12-02T09:00:00Z" }),
      activity(5, { type: "note", metadata: { text: "x" } }),
    ];
    expect(nextAction(list)?.id).toBe(UUID(103));
    expect(nextAction([list[4] as ActivityRow])).toBeNull();
    expect(nextAction([])).toBeNull();
    expect(nextAction([activity(1), activity(2)])?.id).toBe(UUID(101));
  });

  it("sortTimeline : la plus récente d'abord, ordre stable", () => {
    const sorted = sortTimeline([activity(1), activity(3), activity(2)]);
    expect(sorted.map((a) => a.id)).toEqual([UUID(103), UUID(102), UUID(101)]);
    const tied = sortTimeline([activity(2, { created_at: "2026-11-22T10:00:00+00:00" }), activity(1, { created_at: "2026-11-22T10:00:00+00:00" })]);
    expect(tied.map((a) => a.id)).toEqual([UUID(101), UUID(102)]);
  });

  it("dueTasks : tâches dues, la plus en retard d'abord", () => {
    const list = [
      activity(1, { due_at: "2026-12-10T09:00:00Z" }),
      activity(2, { due_at: "2026-12-05T09:00:00Z" }),
      activity(3, { due_at: "2026-12-20T09:00:00Z" }),
      activity(4, { due_at: "2026-12-04T09:00:00Z", completed_at: "2026-12-04T10:00:00Z" }),
    ];
    expect(dueTasks(list, now).map((a) => a.id)).toEqual([UUID(102), UUID(101)]);
  });
});
