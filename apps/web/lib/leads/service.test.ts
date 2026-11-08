import { createDealSchema, createLeadSchema, moveLeadStageSchema, type DealRow, type LeadRow } from "@fusion-leap/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSupabase } from "../tenant/identity";
import { mapLeadsDbError } from "./map-error";
import { assignLead, createDeal, createLead, createPipeline, deleteStage, moveDealStage, moveLeadStage, updateLead } from "./service";

const ORG = "9b000000-0000-4000-8000-00000000000a";
const LEAD = "9e000000-0000-4000-8000-0000000000f1";
const DEAL = "9f000000-0000-4000-8000-0000000000d1";
const STAGE = "9a100000-0000-4000-8000-000000000001";
const NOW = "2026-11-21T10:00:00+00:00";

const lead = (over: Partial<LeadRow> = {}): LeadRow => ({
  id: LEAD, organization_id: ORG, contact_id: "9d000000-0000-4000-8000-0000000000c1", project_id: "9c000000-0000-4000-8000-0000000000a1",
  source: "web_form", stage_id: STAGE, score: null, score_reason: {}, assignee_id: null, campaign_id: null, utm: {}, external_source: null,
  external_id: null, created_at: NOW, updated_at: NOW, ...over,
});
const deal = (over: Partial<DealRow> = {}): DealRow => ({
  id: DEAL, organization_id: ORG, lead_id: LEAD, stage_id: STAGE, value: 1500.5, currency: "MAD", expected_close_at: null, won_at: null,
  lost_at: null, external_source: null, external_id: null, created_at: NOW, updated_at: NOW, ...over,
});

/** Faux client : `rpc` programmable ; `from("leads" | "deals").select().eq().eq().maybeSingle()` renvoie la ligne programmée. */
function fakeClient() {
  const state: { lead: LeadRow | null; deal: DealRow | null; rpc: (name: string, args: Record<string, unknown>) => { data: unknown; error: unknown } } = {
    lead: lead(), deal: deal(), rpc: () => ({ data: null, error: null }),
  };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => state.rpc(name, args));
  const from = (table: "leads" | "deals") => {
    const query: Record<string, unknown> = {};
    for (const name of ["select", "eq"]) query[name] = () => query;
    query.maybeSingle = () => Promise.resolve({ data: table === "leads" ? state.lead : state.deal, error: null });
    return query;
  };
  return { client: { rpc, from } as unknown as ServerSupabase, rpc, state };
}

let c: ReturnType<typeof fakeClient>;
beforeEach(() => {
  c = fakeClient();
});

const parseLead = (raw: Record<string, unknown>) => {
  const parsed = createLeadSchema.safeParse(raw);
  if (!parsed.success) throw new Error("fixture invalide");
  return parsed.data;
};

describe("createLead", () => {
  it("appelle la fonction SQL avec l'entreprise du CONTEXTE (jamais celle de l'entrée) puis relit le lead", async () => {
    c.state.rpc = () => ({ data: LEAD, error: null });
    const input = parseLead({ contact_id: lead().contact_id, project_id: lead().project_id, source: "web_form", organization_id: "7f000000-0000-4000-8000-0000000000ff" });
    const result = await createLead(c.client, ORG, input);
    expect(result).toEqual({ ok: true, value: lead() });
    expect(c.rpc).toHaveBeenCalledWith("create_lead", expect.objectContaining({ p_org: ORG, p_assignee: null, p_score: null, p_utm: {}, p_score_reason: {} }));
    expect(JSON.stringify(c.rpc.mock.calls[0])).not.toContain("7f000000-0000-4000-8000-0000000000ff");
  });

  it.each([
    [{ code: "PT404", message: "not_found" }, "not_found"],
    [{ code: "42501", message: "forbidden" }, "forbidden"],
    [{ code: "P0001", message: "project_archived" }, "conflict"],
    [{ code: "P0001", message: "assignee_invalid" }, "validation_failed"],
    [{ code: "P0001", message: "pipeline_incomplete" }, "conflict"],
    [{ code: "23505", message: "duplicate" }, "conflict"],
    [{ code: "23514", message: "score" }, "validation_failed"],
    [{ code: "XX000", message: "boom" }, "internal_error"],
  ] as const)("erreur %j -> %s", async (error, expected) => {
    c.state.rpc = () => ({ data: null, error });
    const input = parseLead({ contact_id: lead().contact_id, project_id: lead().project_id, source: "manual" });
    expect(await createLead(c.client, ORG, input)).toEqual({ ok: false, code: expected });
  });

  it("lead créé mais illisible ensuite (autre commercial, par exemple) : internal_error", async () => {
    c.state.rpc = () => ({ data: LEAD, error: null });
    c.state.lead = null;
    const input = parseLead({ contact_id: lead().contact_id, project_id: lead().project_id, source: "manual" });
    expect(await createLead(c.client, ORG, input)).toEqual({ ok: false, code: "internal_error" });
  });
});

describe("modification, assignation, étape", () => {
  it("updateLead transmet les champs et relit", async () => {
    const result = await updateLead(c.client, ORG, { lead_id: LEAD, source: "manual", score: 70 });
    expect(result.ok).toBe(true);
    expect(c.rpc).toHaveBeenCalledWith("update_lead", { p_org: ORG, p_id: LEAD, p_source: "manual", p_score: 70, p_score_reason: {}, p_utm: {} });
  });

  it("assignLead : responsable nul accepté ; moveLeadStage : étape transmise", async () => {
    expect((await assignLead(c.client, ORG, { lead_id: LEAD, assignee_id: null })).ok).toBe(true);
    expect(c.rpc).toHaveBeenLastCalledWith("assign_lead", { p_org: ORG, p_id: LEAD, p_assignee: null });
    const move = moveLeadStageSchema.parse({ lead_id: LEAD, stage_id: STAGE });
    expect((await moveLeadStage(c.client, ORG, move)).ok).toBe(true);
    expect(c.rpc).toHaveBeenLastCalledWith("move_lead_stage", { p_org: ORG, p_id: LEAD, p_stage: STAGE });
  });

  it("lead d'un autre commercial : introuvable, rien n'est relu", async () => {
    c.state.rpc = () => ({ data: null, error: { code: "PT404", message: "not_found" } });
    expect(await updateLead(c.client, ORG, { lead_id: LEAD, source: "manual" })).toEqual({ ok: false, code: "not_found" });
  });
});

describe("deals", () => {
  it("createDeal : étape facultative, montant et devise transmis, deal relu", async () => {
    c.state.rpc = () => ({ data: DEAL, error: null });
    const input = createDealSchema.parse({ lead_id: LEAD, value: 1500.5, currency: "MAD", expected_close_at: "2026-12-31T00:00:00Z" });
    const result = await createDeal(c.client, ORG, input);
    expect(result).toEqual({ ok: true, value: deal() });
    expect(c.rpc).toHaveBeenCalledWith("create_deal", { p_org: ORG, p_lead: LEAD, p_stage: null, p_value: 1500.5, p_currency: "MAD", p_expected_close_at: "2026-12-31T00:00:00Z" });
  });

  it("moveDealStage : étape hors pipeline -> validation_failed ; rôle interdit -> forbidden", async () => {
    c.state.rpc = () => ({ data: null, error: { code: "22023", message: "validation_failed" } });
    expect(await moveDealStage(c.client, ORG, { deal_id: DEAL, stage_id: STAGE })).toEqual({ ok: false, code: "validation_failed" });
    c.state.rpc = () => ({ data: null, error: { code: "42501", message: "forbidden" } });
    expect(await moveDealStage(c.client, ORG, { deal_id: DEAL, stage_id: STAGE })).toEqual({ ok: false, code: "forbidden" });
  });
});

describe("pipelines et étapes", () => {
  it("createPipeline renvoie l'identifiant ; deleteStage d'une étape utilisée -> conflict", async () => {
    c.state.rpc = () => ({ data: "9a200000-0000-4000-8000-000000000001", error: null });
    expect(await createPipeline(c.client, ORG, { name: "Partenaires" })).toEqual({ ok: true, value: "9a200000-0000-4000-8000-000000000001" });
    c.state.rpc = () => ({ data: null, error: { code: "P0001", message: "stage_in_use" } });
    expect(await deleteStage(c.client, ORG, { stage_id: STAGE })).toEqual({ ok: false, code: "conflict" });
  });
});

describe("mapLeadsDbError", () => {
  it.each([
    [{ code: "P0001", message: "system_stage" }, "conflict"],
    [{ code: "P0001", message: "last_open_stage" }, "conflict"],
    [{ code: "P0001", message: "too_many_pipelines" }, "conflict"],
    [{ code: "P0001", message: "too_many_stages" }, "conflict"],
    [{ code: "28000" }, "unauthenticated"],
    [null, "internal_error"],
  ] as const)("%j -> %s", (error, expected) => {
    expect(mapLeadsDbError(error)).toBe(expected);
  });
});
