import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, download } = vi.hoisted(() => ({ rpc: vi.fn(), download: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc, storage: { from: () => ({ download }) } }) }));

import { createSupabaseCrmSyncGateway, CrmSyncGatewayError } from "./crm-sync";

const ORG = "11111111-1111-4111-8111-111111111111";
const INT = "77777777-7777-4777-8777-777777777777";
const BATCH = "66666666-6666-4666-8666-666666666666";
const CONTACT = "88888888-8888-4888-8888-888888888888";
const gateway = createSupabaseCrmSyncGateway({ SUPABASE_URL: "http://localhost:54321", SUPABASE_SECRET_KEY: "clé-de-test" });

beforeEach(() => {
  rpc.mockReset();
  download.mockReset();
});

describe("passerelle de synchro CRM (service_role)", () => {
  it("start : l'entreprise vient de la ligne du job ; dates lues ; états sans fichier", async () => {
    rpc.mockResolvedValue({ data: { status: "running", path: "p.csv", provider: "csv", source: `csv:${INT}`, last_sync_at: "2026-11-05T00:00:00Z", last_sync_finished_at: "2026-11-05T00:01:00Z", started_at: "2026-11-20T00:00:00Z", mappings: [] }, error: null });
    expect(await gateway.start(ORG, INT, BATCH)).toMatchObject({ status: "running", path: "p.csv", source: `csv:${INT}`, lastSyncAt: new Date("2026-11-05T00:00:00Z"), lastSyncFinishedAt: new Date("2026-11-05T00:01:00Z"), startedAt: new Date("2026-11-20T00:00:00Z") });
    expect(rpc).toHaveBeenCalledWith("crm_sync_start", { p_org: ORG, p_integration: INT, p_batch: BATCH });
    rpc.mockResolvedValue({ data: { status: "file_missing" }, error: null });
    expect(await gateway.start(ORG, INT, BATCH)).toEqual({ status: "file_missing" });
    rpc.mockResolvedValue({ data: { status: "autre" }, error: null });
    await expect(gateway.start(ORG, INT, BATCH)).rejects.toThrow("crm_sync_start_failed");
  });

  it("find, create, update : valeurs transmises, résultats validés ; erreurs sans valeur de contact", async () => {
    rpc.mockResolvedValue({ data: { status: "found", linked: false, id: CONTACT, name: "Nadia", language: "fr", country: "MA", updated_at: "2026-11-10T00:00:00Z", do_not_contact: false }, error: null });
    expect(await gateway.find(ORG, "csv", "e1", "nadia@x.ma", null)).toMatchObject({ status: "found", linked: false, id: CONTACT, updatedAt: new Date("2026-11-10T00:00:00Z") });
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await gateway.find(ORG, "csv", "e1", null, null)).toBeNull();
    rpc.mockResolvedValue({ data: { status: "created" }, error: null });
    expect(await gateway.create(ORG, "csv", { externalId: "e1", name: "N", emailRaw: "n@x.ma", emailNormalized: "n@x.ma", phoneE164: null, language: null, country: null })).toEqual({ status: "created" });
    expect(rpc).toHaveBeenLastCalledWith("crm_sync_create", expect.objectContaining({ p_org: ORG, p_provider: "csv", p_external_id: "e1", p_email_normalized: "n@x.ma" }));
    rpc.mockResolvedValue({ data: { status: "updated" }, error: null });
    expect(await gateway.update(ORG, CONTACT, "csv", "e1", { name: "X" })).toEqual({ status: "updated" });
    rpc.mockResolvedValue({ data: null, error: { message: "boom, nadia@x.ma" } });
    const error = (await gateway.update(ORG, CONTACT, "csv", "e1", {}).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(CrmSyncGatewayError);
    expect(error.message).toBe("crm_sync_update_failed");
    expect(error.message).not.toContain("nadia");
  });

  it("auditConflict, finish, fail : fonctions SQL avec l'entreprise du job ; date en ISO", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await gateway.auditConflict(ORG, INT, CONTACT, [{ field: "name", winner: "internal" }]);
    await gateway.finish(ORG, INT, BATCH, new Date("2026-11-20T00:00:00Z"), { created: 1, updated: 0, linked: 0, unchanged: 0, skipped: 0, rejected: 0, conflicts: 0 });
    await gateway.fail(ORG, INT, "file_missing");
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["crm_sync_audit_conflict", "crm_sync_finish", "crm_sync_fail"]);
    expect(rpc).toHaveBeenCalledWith("crm_sync_finish", expect.objectContaining({ p_batch: BATCH, p_started_at: "2026-11-20T00:00:00.000Z" }));
    rpc.mockResolvedValue({ data: null, error: { message: "secret" } });
    await expect(gateway.fail(ORG, INT, "failed")).rejects.toThrow("crm_sync_fail_failed");
  });

  it("readFile : octets du Storage ; absent = null ; autre panne = erreur générique", async () => {
    download.mockResolvedValue({ data: { arrayBuffer: async () => new Uint8Array([1, 2]).buffer }, error: null });
    expect(await gateway.readFile("p.csv")).toEqual(new Uint8Array([1, 2]));
    download.mockResolvedValue({ data: null, error: { message: "Object not found", statusCode: "404" } });
    expect(await gateway.readFile("p.csv")).toBeNull();
    download.mockResolvedValue({ data: null, error: { message: "x", statusCode: "500" } });
    await expect(gateway.readFile("p.csv")).rejects.toThrow("crm_sync_read_failed");
  });
});
