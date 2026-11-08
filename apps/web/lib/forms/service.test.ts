import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSupabase } from "../tenant/identity";
import { createFormKey, listFormKeys, setFormKeyActive, setFormKeyOrigins } from "./service";

const ORG = "bb000000-0000-4000-8000-00000000000a";
const PROJECT = "cc000000-0000-4000-8000-0000000000a1";
const KEY_ID = "ce000000-0000-4000-8000-0000000000a1";
const NOW = "2026-11-23T10:00:00+00:00";
const KEY = `flk_${"a1".repeat(32)}`;

type Call = { method: string; args: unknown[] };

function fakeClient() {
  const calls: Call[] = [];
  const state: { rows: unknown; error: unknown; rpc: (name: string, args: Record<string, unknown>) => { data: unknown; error: unknown } } = {
    rows: [], error: null, rpc: () => ({ data: null, error: null }),
  };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => state.rpc(name, args));
  const from = () => {
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "order"]) {
      query[method] = (...args: unknown[]) => {
        calls.push({ method, args });
        return query;
      };
    }
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: state.rows, error: state.error }).then(resolve);
    return query;
  };
  return { client: { rpc, from } as unknown as ServerSupabase, rpc, state, calls };
}

let c: ReturnType<typeof fakeClient>;
beforeEach(() => {
  c = fakeClient();
});

describe("listFormKeys", () => {
  it("lit les colonnes publiques SEULES (jamais l'empreinte), filtrées par entreprise et projet", async () => {
    c.state.rows = [{ id: KEY_ID, organization_id: ORG, project_id: PROJECT, key_prefix: "flk_a1a1", allowed_origins: ["https://exemple.ma"], active: true, created_at: NOW, updated_at: NOW }];
    const rows = await listFormKeys(c.client, ORG, PROJECT);
    expect(rows).toHaveLength(1);
    const columns = c.calls.find((call) => call.method === "select")?.args[0] as string;
    expect(columns).not.toContain("key_hash");
    expect(columns).toContain("key_prefix");
    expect(c.calls).toContainEqual({ method: "eq", args: ["organization_id", ORG] });
    expect(c.calls).toContainEqual({ method: "eq", args: ["project_id", PROJECT] });
  });

  it("erreur ou ligne illisible : erreur générique", async () => {
    c.state.error = { code: "XX000" };
    await expect(listFormKeys(c.client, ORG, PROJECT)).rejects.toThrow("form_keys_lookup_failed");
    c.state.error = null;
    c.state.rows = [{ id: "pas-un-uuid" }];
    await expect(listFormKeys(c.client, ORG, PROJECT)).rejects.toThrow("rows_unreadable");
  });
});

describe("createFormKey", () => {
  it("renvoie la clé en clair UNE fois, avec l'entreprise du CONTEXTE", async () => {
    c.state.rpc = () => ({ data: { id: KEY_ID, key: KEY, key_prefix: "flk_a1a1" }, error: null });
    const result = await createFormKey(c.client, ORG, { project_id: PROJECT, allowed_origins: ["https://exemple.ma"], organization_id: "7f000000-0000-4000-8000-0000000000ff" });
    expect(result).toEqual({ ok: true, value: { id: KEY_ID, key: KEY, keyPrefix: "flk_a1a1" } });
    expect(c.rpc).toHaveBeenCalledWith("create_form_key", { p_org: ORG, p_project: PROJECT, p_origins: ["https://exemple.ma"] });
    expect(JSON.stringify(c.rpc.mock.calls[0])).not.toContain("7f000000-0000-4000-8000-0000000000ff");
  });

  it.each([
    [{ code: "42501", message: "forbidden" }, "forbidden"],
    [{ code: "PT404", message: "not_found" }, "not_found"],
    [{ code: "P0001", message: "project_archived" }, "conflict"],
    [{ code: "P0001", message: "too_many_form_keys" }, "conflict"],
    [{ code: "P0001", message: "subscription_inactive" }, "quota_exceeded"],
    [{ code: "22023", message: "validation_failed" }, "validation_failed"],
    [{ code: "XX000", message: "boom" }, "internal_error"],
  ] as const)("erreur %j -> %s", async (error, expected) => {
    c.state.rpc = () => ({ data: null, error });
    expect(await createFormKey(c.client, ORG, { project_id: PROJECT, allowed_origins: ["https://exemple.ma"] })).toEqual({ ok: false, code: expected });
  });

  it("réponse illisible : internal_error", async () => {
    c.state.rpc = () => ({ data: { id: KEY_ID }, error: null });
    expect(await createFormKey(c.client, ORG, { project_id: PROJECT, allowed_origins: ["https://exemple.ma"] })).toEqual({ ok: false, code: "internal_error" });
  });
});

describe("révocation et origines", () => {
  it("setFormKeyActive et setFormKeyOrigins transmettent l'identifiant de la clé", async () => {
    expect(await setFormKeyActive(c.client, ORG, { key_id: KEY_ID, active: false })).toEqual({ ok: true, value: true });
    expect(c.rpc).toHaveBeenLastCalledWith("set_form_key_active", { p_org: ORG, p_id: KEY_ID, p_active: false });
    expect(await setFormKeyOrigins(c.client, ORG, { key_id: KEY_ID, allowed_origins: ["https://autre.ma"] })).toEqual({ ok: true, value: true });
    expect(c.rpc).toHaveBeenLastCalledWith("set_form_key_origins", { p_org: ORG, p_id: KEY_ID, p_origins: ["https://autre.ma"] });
    c.state.rpc = () => ({ data: null, error: { code: "42501", message: "forbidden" } });
    expect(await setFormKeyActive(c.client, ORG, { key_id: KEY_ID, active: true })).toEqual({ ok: false, code: "forbidden" });
  });
});
