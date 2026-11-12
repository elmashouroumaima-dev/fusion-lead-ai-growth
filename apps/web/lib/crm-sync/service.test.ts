import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSupabase } from "../tenant/identity";
import { createIntegration, listIntegrations, requestSync, retrySync, saveMappings } from "./service";

const ORG = "bb000000-0000-4000-8000-00000000000a";
const INT = "7a000000-0000-4000-8000-000000000001";
const BATCH = "7b000000-0000-4000-8000-000000000001";
const NOW = "2026-11-27T10:00:00+00:00";

function fakeClient() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const state = {
    integrations: [] as unknown[],
    mappings: [] as unknown[],
    dbError: null as unknown,
    rpc: ((): { data: unknown; error: unknown } => ({ data: null, error: null })) as (name: string) => { data: unknown; error: unknown },
  };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ op: `rpc:${name}`, args: [args] });
    return state.rpc(name);
  });
  const from = (table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "order"]) {
      query[method] = (...args: unknown[]) => {
        calls.push({ op: `${table}.${method}`, args });
        return query;
      };
    }
    query.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: table === "integrations" ? state.integrations : state.mappings, error: state.dbError }).then(resolve);
    return query;
  };
  return { client: { rpc, from } as unknown as ServerSupabase, rpc, state, calls };
}

let c: ReturnType<typeof fakeClient>;
beforeEach(() => {
  c = fakeClient();
});

const integrationRow = { id: INT, organization_id: ORG, provider: "csv", status: "active", external_account_id: "compte", last_sync_at: null, last_error: null, created_at: NOW, updated_at: NOW };
const mappingRow = { id: "7c000000-0000-4000-8000-000000000001", integration_id: INT, entity: "contact", internal_field: "external_id", external_field: "ID", source_of_truth: "external", direction: "pull" };

describe("listIntegrations", () => {
  it("intégrations de l'entreprise du contexte avec mapping et statut de synchro", async () => {
    c.state.integrations = [integrationRow];
    c.state.mappings = [mappingRow];
    c.state.rpc = () => ({ data: { status: "failed", last_sync_at: NOW, last_error: "file_missing" }, error: null });
    const views = await listIntegrations(c.client, ORG);
    expect(views).toEqual([{ integration: integrationRow, mappings: [mappingRow], sync: { status: "failed", lastSyncAt: NOW, lastError: "file_missing" } }]);
    expect(c.calls).toContainEqual({ op: "integrations.eq", args: ["organization_id", ORG] });
    expect(c.calls).toContainEqual({ op: "crm_field_mappings.eq", args: ["organization_id", ORG] });
    expect(c.rpc).toHaveBeenCalledWith("crm_sync_status", { p_org: ORG, p_integration: INT });
  });

  it("statut inconnu : « jamais synchronisé » ; erreur ou ligne illisible : erreur générique", async () => {
    c.state.integrations = [integrationRow];
    c.state.rpc = () => ({ data: { status: "n'importe quoi" }, error: null });
    expect((await listIntegrations(c.client, ORG))[0]?.sync).toEqual({ status: "never", lastSyncAt: null, lastError: null });
    c.state.rpc = () => ({ data: null, error: { message: "secret" } });
    await expect(listIntegrations(c.client, ORG)).rejects.toThrow("sync_status_failed");
    c.state.integrations = [{ id: "x" }];
    await expect(listIntegrations(c.client, ORG)).rejects.toThrow("rows_unreadable");
    c.state.dbError = { message: "secret" };
    await expect(listIntegrations(c.client, ORG)).rejects.toThrow("integrations_lookup_failed");
  });
});

describe("écritures : entreprise du contexte et codes d'erreur", () => {
  it("createIntegration, saveMappings, requestSync, retrySync appellent les fonctions avec l'entreprise du contexte", async () => {
    c.state.rpc = (name) => ({ data: name === "create_integration" ? INT : name === "request_crm_sync" ? "7d000000-0000-4000-8000-000000000001" : name === "retry_crm_sync" ? true : null, error: null });
    expect(await createIntegration(c.client, ORG, { provider: "csv", external_account_id: "compte" })).toEqual({ ok: true, value: { id: INT } });
    expect(c.rpc).toHaveBeenCalledWith("create_integration", { p_org: ORG, p_provider: "csv", p_account: "compte" });
    const mappings = [{ entity: "contact" as const, internal_field: "external_id" as const, external_field: "ID", source_of_truth: "external" as const, direction: "pull" as const }, { entity: "contact" as const, internal_field: "name" as const, external_field: "Nom", source_of_truth: "internal" as const, direction: "both" as const }];
    expect(await saveMappings(c.client, ORG, { integration_id: INT, mappings })).toEqual({ ok: true, value: true });
    expect(c.rpc).toHaveBeenCalledWith("save_crm_mappings", { p_org: ORG, p_integration: INT, p_mappings: mappings });
    expect(await requestSync(c.client, ORG, { integration_id: INT, batch_id: BATCH })).toEqual({ ok: true, value: { jobId: "7d000000-0000-4000-8000-000000000001" } });
    expect(c.rpc).toHaveBeenCalledWith("request_crm_sync", { p_org: ORG, p_integration: INT, p_batch: BATCH });
    expect(await retrySync(c.client, ORG, { integration_id: INT })).toEqual({ ok: true, value: { retried: true } });
  });

  it("erreurs de la base : conflit (synchro en cours, mapping absent, doublon), introuvable, interdit ; réponse inattendue : internal_error", async () => {
    c.state.rpc = () => ({ data: null, error: { code: "P0001", message: "sync_in_progress" } });
    expect(await requestSync(c.client, ORG, { integration_id: INT, batch_id: BATCH })).toEqual({ ok: false, code: "conflict" });
    c.state.rpc = () => ({ data: null, error: { code: "P0001", message: "mapping_missing" } });
    expect(await requestSync(c.client, ORG, { integration_id: INT, batch_id: BATCH })).toEqual({ ok: false, code: "conflict" });
    c.state.rpc = () => ({ data: null, error: { code: "23505", message: "dup" } });
    expect(await createIntegration(c.client, ORG, { provider: "csv", external_account_id: "compte" })).toEqual({ ok: false, code: "conflict" });
    c.state.rpc = () => ({ data: null, error: { code: "PT404", message: "not_found" } });
    expect(await retrySync(c.client, ORG, { integration_id: INT })).toEqual({ ok: false, code: "not_found" });
    c.state.rpc = () => ({ data: null, error: { code: "42501", message: "forbidden" } });
    expect(await saveMappings(c.client, ORG, { integration_id: INT, mappings: [] as never })).toEqual({ ok: false, code: "forbidden" });
    c.state.rpc = () => ({ data: { x: 1 }, error: null });
    expect(await createIntegration(c.client, ORG, { provider: "csv", external_account_id: "compte" })).toEqual({ ok: false, code: "internal_error" });
  });

  it("rejeu sans rien à rejouer : retried = false", async () => {
    c.state.rpc = () => ({ data: false, error: null });
    expect(await retrySync(c.client, ORG, { integration_id: INT })).toEqual({ ok: true, value: { retried: false } });
  });
});
