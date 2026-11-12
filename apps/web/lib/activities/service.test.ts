import { completeTaskSchema, createActivitySchema, updateTaskSchema, type ActivityRow } from "@fusion-leap/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSupabase } from "../tenant/identity";
import { mapActivitiesDbError } from "./map-error";
import { listDueTasks, listTimeline, nextActionsFor } from "./queries";
import { completeTask, createActivity, updateTask } from "./service";

const ORG = "bb000000-0000-4000-8000-00000000000a";
const LEAD = "bf000000-0000-4000-8000-0000000000e1";
const LEAD2 = "bf000000-0000-4000-8000-0000000000e2";
const ACTIVITY = "be000000-0000-4000-8000-0000000000a1";
const NOW = "2026-11-22T10:00:00+00:00";

const activity = (over: Partial<ActivityRow> = {}): ActivityRow => ({
  id: ACTIVITY, organization_id: ORG, lead_id: LEAD, contact_id: "bd000000-0000-4000-8000-0000000000c1", type: "task",
  owner_id: "ba000000-0000-4000-8000-000000000004", due_at: null, completed_at: null, metadata: { title: "Relancer" }, created_at: NOW,
  updated_at: NOW, ...over,
});

type Call = { method: string; args: unknown[] };

/** Faux client : `rpc` programmable ; `from("activities")` enregistre les appels et renvoie des lignes programmées. */
function fakeClient() {
  const state: { rows: unknown; single: unknown; rpc: (name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }; failRead: boolean } = {
    rows: [], single: activity(), rpc: () => ({ data: null, error: null }), failRead: false,
  };
  const calls: Call[] = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => state.rpc(name, args));
  const from = () => {
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "is", "not", "lte", "in", "order", "range", "limit"]) {
      query[method] = (...args: unknown[]) => {
        calls.push({ method, args });
        return query;
      };
    }
    const result = () => ({ data: state.rows, error: state.failRead ? { code: "XX000" } : null });
    query.maybeSingle = () => Promise.resolve({ data: state.single, error: state.failRead ? { code: "XX000" } : null });
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve);
    return query;
  };
  return { client: { rpc, from } as unknown as ServerSupabase, rpc, state, calls };
}

let c: ReturnType<typeof fakeClient>;
beforeEach(() => {
  c = fakeClient();
});

const parse = (raw: Record<string, unknown>) => {
  const parsed = createActivitySchema.safeParse(raw);
  if (!parsed.success) throw new Error("fixture invalide");
  return parsed.data;
};

describe("createActivity", () => {
  it("appelle la fonction SQL avec l'entreprise du CONTEXTE (jamais celle de l'entrée) puis relit l'activité", async () => {
    c.state.rpc = () => ({ data: ACTIVITY, error: null });
    const input = parse({ lead_id: LEAD, type: "task", metadata: { title: "Relancer" }, due_at: "2026-12-10T09:00:00Z", organization_id: "7f000000-0000-4000-8000-0000000000ff" });
    const result = await createActivity(c.client, ORG, input);
    expect(result).toEqual({ ok: true, value: activity() });
    expect(c.rpc).toHaveBeenCalledWith("create_activity", {
      p_org: ORG, p_lead: LEAD, p_type: "task", p_metadata: { title: "Relancer" }, p_due_at: "2026-12-10T09:00:00Z", p_owner: null,
    });
    expect(JSON.stringify(c.rpc.mock.calls[0])).not.toContain("7f000000-0000-4000-8000-0000000000ff");
  });

  it.each([
    [{ code: "PT404", message: "not_found" }, "not_found"],
    [{ code: "42501", message: "forbidden" }, "forbidden"],
    [{ code: "P0001", message: "project_archived" }, "conflict"],
    [{ code: "P0001", message: "too_many_activities" }, "conflict"],
    [{ code: "P0001", message: "assignee_invalid" }, "validation_failed"],
    [{ code: "P0001", message: "subscription_inactive" }, "quota_exceeded"],
    [{ code: "23514", message: "metadata" }, "validation_failed"],
    [{ code: "XX000", message: "boom" }, "internal_error"],
  ] as const)("erreur %j -> %s", async (error, expected) => {
    c.state.rpc = () => ({ data: null, error });
    const input = parse({ lead_id: LEAD, type: "note", metadata: { text: "x" } });
    expect(await createActivity(c.client, ORG, input)).toEqual({ ok: false, code: expected });
  });

  it("écriture réussie mais lecture impossible : internal_error", async () => {
    c.state.rpc = () => ({ data: ACTIVITY, error: null });
    c.state.single = null;
    expect(await createActivity(c.client, ORG, parse({ lead_id: LEAD, type: "note", metadata: { text: "x" } }))).toEqual({ ok: false, code: "internal_error" });
  });
});

describe("updateTask et completeTask", () => {
  it("updateTask : responsable absent = inchangé (null transmis)", async () => {
    const input = updateTaskSchema.parse({ activity_id: ACTIVITY, metadata: { title: "Relancer" }, due_at: "2026-12-12T09:00:00Z" });
    expect(updateTaskSchema.safeParse({ activity_id: ACTIVITY, metadata: { title: "Relancer" } }).success).toBe(false);
    expect((await updateTask(c.client, ORG, input)).ok).toBe(true);
    expect(c.rpc).toHaveBeenCalledWith("update_task", { p_org: ORG, p_id: ACTIVITY, p_metadata: { title: "Relancer" }, p_due_at: "2026-12-12T09:00:00Z", p_owner: null });
  });

  it("completeTask : fait / à refaire ; lead d'un autre commercial -> not_found", async () => {
    expect((await completeTask(c.client, ORG, completeTaskSchema.parse({ activity_id: ACTIVITY, done: true }))).ok).toBe(true);
    expect(c.rpc).toHaveBeenLastCalledWith("complete_task", { p_org: ORG, p_id: ACTIVITY, p_done: true });
    c.state.rpc = () => ({ data: null, error: { code: "PT404", message: "not_found" } });
    expect(await completeTask(c.client, ORG, { activity_id: ACTIVITY, done: false })).toEqual({ ok: false, code: "not_found" });
  });
});

describe("lectures", () => {
  it("listTimeline : filtre entreprise et lead, la plus récente d'abord, pagination bornée", async () => {
    c.state.rows = [activity()];
    expect(await listTimeline(c.client, ORG, LEAD, { limit: 9999, offset: -5 })).toEqual([activity()]);
    expect(c.calls).toContainEqual({ method: "eq", args: ["organization_id", ORG] });
    expect(c.calls).toContainEqual({ method: "eq", args: ["lead_id", LEAD] });
    expect(c.calls).toContainEqual({ method: "order", args: ["created_at", { ascending: false }] });
    expect(c.calls).toContainEqual({ method: "range", args: [0, 199] });
  });

  it("listDueTasks : tâches ouvertes avec échéance atteinte, responsable en filtre", async () => {
    c.state.rows = [];
    const now = new Date("2026-12-11T00:00:00Z");
    await listDueTasks(c.client, ORG, { ownerId: "ba000000-0000-4000-8000-000000000004", now });
    expect(c.calls).toContainEqual({ method: "eq", args: ["type", "task"] });
    expect(c.calls).toContainEqual({ method: "is", args: ["completed_at", null] });
    expect(c.calls).toContainEqual({ method: "lte", args: ["due_at", now.toISOString()] });
    expect(c.calls).toContainEqual({ method: "eq", args: ["owner_id", "ba000000-0000-4000-8000-000000000004"] });
  });

  it("nextActionsFor : une prochaine action par lead (échéance la plus proche), leads sans tâche absents, aucune lecture si liste vide", async () => {
    const near = activity({ id: "be000000-0000-4000-8000-0000000000a2", due_at: "2026-12-12T09:00:00Z" });
    const far = activity({ id: "be000000-0000-4000-8000-0000000000a3", due_at: "2026-12-20T09:00:00Z" });
    const other = activity({ id: "be000000-0000-4000-8000-0000000000a4", lead_id: LEAD2, due_at: null });
    c.state.rows = [far, near, other];
    const map = await nextActionsFor(c.client, ORG, [LEAD, LEAD2, LEAD, "bf000000-0000-4000-8000-0000000000e3"]);
    expect(map.get(LEAD)?.id).toBe(near.id);
    expect(map.get(LEAD2)?.id).toBe(other.id);
    expect(map.size).toBe(2);
    expect(c.calls).toContainEqual({ method: "in", args: ["lead_id", [LEAD, LEAD2, "bf000000-0000-4000-8000-0000000000e3"]] });
    c.calls.length = 0;
    expect((await nextActionsFor(c.client, ORG, [])).size).toBe(0);
    expect(c.calls).toEqual([]);
  });

  it("ligne illisible ou erreur de lecture : erreur générique", async () => {
    c.state.rows = [{ id: "pas-un-uuid" }];
    await expect(listTimeline(c.client, ORG, LEAD)).rejects.toThrow("rows_unreadable");
    c.state.rows = [];
    c.state.failRead = true;
    await expect(listTimeline(c.client, ORG, LEAD)).rejects.toThrow("activities_lookup_failed");
  });
});

describe("mapActivitiesDbError", () => {
  it("transmet les codes des leads et ajoute le plafond d'activités", () => {
    expect(mapActivitiesDbError({ code: "P0001", message: "too_many_activities" })).toBe("conflict");
    expect(mapActivitiesDbError({ code: "23505" })).toBe("conflict");
    expect(mapActivitiesDbError(null)).toBe("internal_error");
  });
});
