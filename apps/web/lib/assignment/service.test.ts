import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSupabase } from "../tenant/identity";
import {
  createAssignmentRule,
  deleteAssignmentRule,
  listAssignmentRules,
  listNotifications,
  listUnassignedLeads,
  markNotificationRead,
  updateAssignmentRule,
} from "./service";

const ORG = "bb000000-0000-4000-8000-00000000000a";
const RULE = "ee000000-0000-4000-8000-0000000000a1";
const USER_A = "ea000000-0000-4000-8000-000000000004";
const USER_B = "ea000000-0000-4000-8000-000000000005";
const STAGE = "ef000000-0000-4000-8000-0000000000a1";
const NOW = "2026-11-24T10:00:00+00:00";

type Call = { table: string; method: string; args: unknown[] };

function fakeClient() {
  const calls: Call[] = [];
  const state: { rows: Record<string, unknown>; error: unknown; count: number | null; rpc: (name: string, args: Record<string, unknown>) => { data: unknown; error: unknown } } = {
    rows: {}, error: null, count: null, rpc: () => ({ data: null, error: null }),
  };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => state.rpc(name, args));
  const from = (table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "is", "order", "range"]) {
      query[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return query;
      };
    }
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: state.rows[table] ?? [], error: state.error, count: state.count }).then(resolve);
    return query;
  };
  return { client: { rpc, from } as unknown as ServerSupabase, rpc, state, calls };
}

let c: ReturnType<typeof fakeClient>;
beforeEach(() => {
  c = fakeClient();
});

const ruleRow = { id: RULE, organization_id: ORG, project_id: null, strategy: "round_robin", eligible_member_ids: [USER_A, USER_B], cursor: 0, active: true, created_at: NOW, updated_at: NOW };

describe("listAssignmentRules", () => {
  it("lit les règles de l'entreprise du contexte, plus anciennes d'abord", async () => {
    c.state.rows.assignment_rules = [ruleRow];
    expect(await listAssignmentRules(c.client, ORG)).toEqual([ruleRow]);
    expect(c.calls).toContainEqual({ table: "assignment_rules", method: "eq", args: ["organization_id", ORG] });
  });

  it("erreur ou ligne illisible : erreur générique", async () => {
    c.state.error = { message: "secret sql" };
    await expect(listAssignmentRules(c.client, ORG)).rejects.toThrow("assignment_rules_lookup_failed");
    c.state.error = null;
    c.state.rows.assignment_rules = [{ id: "x" }];
    await expect(listAssignmentRules(c.client, ORG)).rejects.toThrow("rows_unreadable");
  });
});

describe("écriture des règles", () => {
  it("createAssignmentRule : entreprise du contexte, projet nul = règle par défaut ; renvoie l'identifiant", async () => {
    c.state.rpc = () => ({ data: RULE, error: null });
    const result = await createAssignmentRule(c.client, ORG, { project_id: null, strategy: "round_robin", eligible_member_ids: [USER_A, USER_B] });
    expect(result).toEqual({ ok: true, value: { id: RULE } });
    expect(c.rpc).toHaveBeenCalledWith("create_assignment_rule", { p_org: ORG, p_project: null, p_strategy: "round_robin", p_members: [USER_A, USER_B] });
  });

  it("réponse inattendue : internal_error", async () => {
    c.state.rpc = () => ({ data: { x: 1 }, error: null });
    expect(await createAssignmentRule(c.client, ORG, { project_id: null, strategy: "fixed", eligible_member_ids: [USER_A] })).toEqual({ ok: false, code: "internal_error" });
  });

  it("erreurs de la base : codes d'API (jamais le message brut)", async () => {
    const input = { project_id: null, strategy: "fixed" as const, eligible_member_ids: [USER_A] };
    c.state.rpc = () => ({ data: null, error: { code: "P0001", message: "assignment_rule_exists" } });
    expect(await createAssignmentRule(c.client, ORG, input)).toEqual({ ok: false, code: "conflict" });
    c.state.rpc = () => ({ data: null, error: { code: "P0001", message: "too_many_assignment_rules" } });
    expect(await createAssignmentRule(c.client, ORG, input)).toEqual({ ok: false, code: "conflict" });
    c.state.rpc = () => ({ data: null, error: { code: "P0001", message: "assignee_invalid" } });
    expect(await createAssignmentRule(c.client, ORG, input)).toEqual({ ok: false, code: "validation_failed" });
    c.state.rpc = () => ({ data: null, error: { code: "42501", message: "forbidden" } });
    expect(await createAssignmentRule(c.client, ORG, input)).toEqual({ ok: false, code: "forbidden" });
  });

  it("updateAssignmentRule et deleteAssignmentRule : appellent les fonctions avec l'entreprise du contexte", async () => {
    expect(await updateAssignmentRule(c.client, ORG, { rule_id: RULE, strategy: "fixed", eligible_member_ids: [USER_A], active: false })).toEqual({ ok: true, value: true });
    expect(c.rpc).toHaveBeenCalledWith("update_assignment_rule", { p_org: ORG, p_id: RULE, p_strategy: "fixed", p_members: [USER_A], p_active: false });
    expect(await deleteAssignmentRule(c.client, ORG, { rule_id: RULE })).toEqual({ ok: true, value: true });
    expect(c.rpc).toHaveBeenCalledWith("delete_assignment_rule", { p_org: ORG, p_id: RULE });
    c.state.rpc = () => ({ data: null, error: { code: "PT404", message: "not_found" } });
    expect(await deleteAssignmentRule(c.client, ORG, { rule_id: RULE })).toEqual({ ok: false, code: "not_found" });
  });
});

describe("listUnassignedLeads", () => {
  it("lit les leads des étapes « non assigné » sans responsable, le plus ancien d'abord, avec le total", async () => {
    c.state.rows.pipeline_stages = [{ id: STAGE }];
    c.state.rows.leads = [{ id: "ec000000-0000-4000-8000-000000000001" }];
    c.state.count = 7;
    const queue = await listUnassignedLeads(c.client, ORG);
    expect(queue).toEqual({ leads: [{ id: "ec000000-0000-4000-8000-000000000001" }], total: 7 });
    expect(c.calls).toContainEqual({ table: "pipeline_stages", method: "eq", args: ["kind", "unassigned"] });
    expect(c.calls).toContainEqual({ table: "leads", method: "in", args: ["stage_id", [STAGE]] });
    expect(c.calls).toContainEqual({ table: "leads", method: "is", args: ["assignee_id", null] });
    expect(c.calls).toContainEqual({ table: "leads", method: "eq", args: ["organization_id", ORG] });
  });

  it("aucune étape « non assigné » : file vide sans lire les leads", async () => {
    c.state.rows.pipeline_stages = [];
    expect(await listUnassignedLeads(c.client, ORG)).toEqual({ leads: [], total: 0 });
    expect(c.calls.some((call) => call.table === "leads")).toBe(false);
  });

  it("erreur : erreur générique", async () => {
    c.state.error = { message: "secret" };
    await expect(listUnassignedLeads(c.client, ORG)).rejects.toThrow("stages_lookup_failed");
  });
});

describe("notifications", () => {
  const notification = { id: "e0000000-0000-4000-8000-000000000001", organization_id: ORG, recipient_id: USER_A, kind: "lead.unassigned", payload: { lead_id: STAGE, reason: "no_rule" }, read_at: null, created_at: NOW };

  it("liste : entreprise du contexte, non lues seulement à la demande, limite bornée", async () => {
    c.state.rows.notifications = [notification];
    expect(await listNotifications(c.client, ORG, { unreadOnly: true, limit: 5000 })).toEqual([notification]);
    expect(c.calls).toContainEqual({ table: "notifications", method: "is", args: ["read_at", null] });
    expect(c.calls).toContainEqual({ table: "notifications", method: "range", args: [0, 199] });
  });

  it("ligne illisible : erreur générique", async () => {
    c.state.rows.notifications = [{ ...notification, kind: "autre" }];
    await expect(listNotifications(c.client, ORG)).rejects.toThrow("rows_unreadable");
  });

  it("marquage « lu » : fonction avec l'entreprise du contexte ; notification d'un autre : introuvable", async () => {
    expect(await markNotificationRead(c.client, ORG, { notification_id: notification.id })).toEqual({ ok: true, value: true });
    expect(c.rpc).toHaveBeenCalledWith("mark_notification_read", { p_org: ORG, p_id: notification.id });
    c.state.rpc = () => ({ data: null, error: { code: "PT404", message: "not_found" } });
    expect(await markNotificationRead(c.client, ORG, { notification_id: notification.id })).toEqual({ ok: false, code: "not_found" });
  });
});
