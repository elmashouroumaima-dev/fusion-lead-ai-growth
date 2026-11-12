import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeadListFilters } from "@fusion-leap/domain";
import type { ServerSupabase } from "../tenant/identity";
import { BOARD_MAX_DEALS, exportLeads, listBoardDeals, searchLeads } from "./service";

const ORG = "bb000000-0000-4000-8000-00000000000a";
const U = (n: number) => `7e000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = "2026-11-26T10:00:00+00:00";
const filters = (over: Partial<LeadListFilters> = {}): LeadListFilters => ({
  project: null, stage: null, source: null, assignee: null, unassigned: false, query: null, sort: "created_desc", ...over,
});
const row = (n: number, total = 3) => ({
  id: U(n), contact_id: U(100 + n), project_id: U(200), source: "web_form", stage_id: U(300), stage_name: "New", stage_kind: "open", assignee_id: null,
  score: null, created_at: NOW, updated_at: NOW, contact_name: `N${n}`, contact_email: `n${n}@x.ma`, contact_phone: null, total_count: String(total),
});

function fakeClient() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const state = {
    rpc: ((): { data: unknown; error: unknown } => ({ data: [], error: null })) as (name: string, args: unknown) => { data: unknown; error: unknown },
    deals: [] as unknown[],
    dealsError: null as unknown,
  };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ op: `rpc:${name}`, args: [args] });
    return state.rpc(name, args);
  });
  const from = (table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "order", "range"]) {
      query[method] = (...args: unknown[]) => {
        calls.push({ op: `${table}.${method}`, args });
        return query;
      };
    }
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: state.deals, error: state.dealsError }).then(resolve);
    return query;
  };
  return { client: { rpc, from } as unknown as ServerSupabase, rpc, state, calls };
}

let c: ReturnType<typeof fakeClient>;
beforeEach(() => {
  c = fakeClient();
});

describe("searchLeads", () => {
  it("filtres transmis à search_leads avec l'entreprise du contexte ; 25 par page, décalage selon la page ; total et nombre de pages", async () => {
    c.state.rpc = () => ({ data: [row(1, 60), row(2, 60)], error: null });
    const page = await searchLeads(c.client, ORG, filters({ project: U(7), query: "nadia", unassigned: true, sort: "name_asc" }), 3);
    expect(c.rpc).toHaveBeenCalledWith("search_leads", {
      p_org: ORG, p_project: U(7), p_stage: null, p_source: null, p_assignee: null, p_unassigned: true, p_query: "nadia", p_sort: "name_asc", p_limit: 25, p_offset: 50,
    });
    expect(page).toMatchObject({ total: 60, page: 3, pageSize: 25, pageCount: 3 });
    expect(page.rows[0]).toMatchObject({ id: U(1), total_count: 60 });
  });

  it("aucun résultat : total 0, une page ; erreur ou ligne illisible : erreur générique", async () => {
    expect(await searchLeads(c.client, ORG, filters(), 1)).toMatchObject({ total: 0, pageCount: 1, rows: [] });
    c.state.rpc = () => ({ data: null, error: { message: "secret sql" } });
    await expect(searchLeads(c.client, ORG, filters(), 1)).rejects.toThrow("leads_search_failed");
    c.state.rpc = () => ({ data: [{ id: "x" }], error: null });
    await expect(searchLeads(c.client, ORG, filters(), 1)).rejects.toThrow("rows_unreadable");
  });
});

describe("searchLeads : page au-delà du total", () => {
  it("aucune ligne sur la page demandée : le total est relu (page 1, une ligne) pour garder la navigation", async () => {
    c.state.rpc = (_n, args) => ((args as { p_offset: number }).p_offset > 0 ? { data: [], error: null } : { data: [row(1, 60)], error: null });
    const page = await searchLeads(c.client, ORG, filters(), 4000);
    expect(page).toMatchObject({ rows: [], total: 60, pageCount: 3, page: 4000 });
    expect(c.calls.map((call) => (call.args[0] as { p_limit: number }).p_limit)).toEqual([25, 1]);
  });
});

describe("exportLeads : jamais tronqué en silence", () => {
  it("plus de 10 000 résultats : refusé (affiner les filtres), AUCUN audit écrit", async () => {
    c.state.rpc = () => ({ data: [row(1, 10001)], error: null });
    expect(await exportLeads(c.client, ORG, filters())).toEqual({ ok: false, code: "payload_too_large" });
    expect(c.calls.map((call) => call.op)).toEqual(["rpc:search_leads"]);
  });

  it("exactement 10 000 résultats : exporté", async () => {
    c.state.rpc = (name) => (name === "search_leads" ? { data: [row(1, 10000)], error: null } : { data: U(1), error: null });
    expect((await exportLeads(c.client, ORG, filters())).ok).toBe(true);
  });
});

describe("exportLeads", () => {
  it("10 000 lignes au plus depuis le début ; l'audit ne reçoit que le nombre de lignes et les NOMS des filtres", async () => {
    c.state.rpc = (name) => (name === "search_leads" ? { data: [row(1), row(2)], error: null } : { data: U(999), error: null });
    const result = await exportLeads(c.client, ORG, filters({ query: "nadia@exemple.ma", project: U(7) }));
    expect(result.ok && result.value).toHaveLength(2);
    expect(c.calls[0]).toMatchObject({ op: "rpc:search_leads" });
    expect((c.calls[0]?.args[0] as { p_limit: number; p_offset: number }).p_limit).toBe(10000);
    expect((c.calls[0]?.args[0] as { p_limit: number; p_offset: number }).p_offset).toBe(0);
    expect(c.rpc).toHaveBeenLastCalledWith("log_export", { p_org: ORG, p_kind: "leads", p_count: 2, p_filters: { project: true, query: true } });
    expect(JSON.stringify(c.calls)).not.toContain("log_export\",{\"p_org\":\"" + ORG + "\",\"p_kind\":\"leads\",\"p_count\":2,\"p_filters\":{\"project\":\"");
  });

  it("l'audit est écrit APRÈS la lecture et AVANT de rendre les lignes : sans audit, pas d'export", async () => {
    c.state.rpc = (name) => (name === "search_leads" ? { data: [row(1)], error: null } : { data: null, error: { code: "42501", message: "forbidden" } });
    expect(await exportLeads(c.client, ORG, filters())).toEqual({ ok: false, code: "forbidden" });
    expect(c.calls.map((call) => call.op)).toEqual(["rpc:search_leads", "rpc:log_export"]);
  });

  it("rôle refusé par la base : forbidden sans rien lire de plus ; ligne illisible : internal_error, aucun audit", async () => {
    c.state.rpc = () => ({ data: null, error: { code: "42501", message: "forbidden" } });
    expect(await exportLeads(c.client, ORG, filters())).toEqual({ ok: false, code: "forbidden" });
    c.calls.length = 0;
    c.state.rpc = () => ({ data: [{ id: "x" }], error: null });
    expect(await exportLeads(c.client, ORG, filters())).toEqual({ ok: false, code: "internal_error" });
    expect(c.calls.map((call) => call.op)).toEqual(["rpc:search_leads"]);
  });
});

describe("listBoardDeals", () => {
  const deal = (n: number, over: Record<string, unknown> = {}) => ({
    id: U(n), stage_id: U(50), value: "1500.50", currency: "MAD", lead_id: U(60 + n), leads: { assignee_id: U(4), contacts: { name: `Contact ${n}` } }, ...over,
  });

  it("deals avec le nom du contact de leur lead ; valeur décimale lue en nombre ; filtre projet sur le lead ; entreprise du contexte", async () => {
    c.state.deals = [deal(1), deal(2, { value: null, leads: { assignee_id: null, contacts: null } })];
    const deals = await listBoardDeals(c.client, ORG, { projectId: U(7) });
    expect(deals).toEqual([
      { id: U(1), stageId: U(50), value: 1500.5, currency: "MAD", leadId: U(61), contactName: "Contact 1", assigneeId: U(4) },
      { id: U(2), stageId: U(50), value: null, currency: "MAD", leadId: U(62), contactName: null, assigneeId: null },
    ]);
    expect(c.calls).toContainEqual({ op: "deals.eq", args: ["organization_id", ORG] });
    expect(c.calls).toContainEqual({ op: "deals.eq", args: ["leads.project_id", U(7)] });
    expect(c.calls).toContainEqual({ op: "deals.range", args: [0, BOARD_MAX_DEALS - 1] });
  });

  it("sans filtre de projet : aucun filtre sur le lead ; erreur ou ligne illisible : erreur générique", async () => {
    await listBoardDeals(c.client, ORG);
    expect(c.calls.some((call) => call.op === "deals.eq" && call.args[0] === "leads.project_id")).toBe(false);
    c.state.dealsError = { message: "secret" };
    await expect(listBoardDeals(c.client, ORG)).rejects.toThrow("deals_board_failed");
    c.state.dealsError = null;
    c.state.deals = [{ id: 5 }];
    await expect(listBoardDeals(c.client, ORG)).rejects.toThrow("rows_unreadable");
  });
});
