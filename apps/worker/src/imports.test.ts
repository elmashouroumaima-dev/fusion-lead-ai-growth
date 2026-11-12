import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, download } = vi.hoisted(() => ({ rpc: vi.fn(), download: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc, storage: { from: () => ({ download }) } }) }));

import { createSupabaseImportGateway, ImportGatewayError } from "./imports";

const ORG = "11111111-1111-4111-8111-111111111111";
const BATCH = "66666666-6666-4666-8666-666666666666";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const gateway = createSupabaseImportGateway({ SUPABASE_URL: "http://localhost:54321", SUPABASE_SECRET_KEY: "clé-de-test" });
const value = { name: "Nadia", email_raw: "Nadia@x.com", email_normalized: "nadia@x.com", phone_e164: null, language: "fr", country: "MA" };

beforeEach(() => {
  rpc.mockReset();
  download.mockReset();
});

describe("passerelle d'import (service_role)", () => {
  it("start : l'entreprise vient de la ligne du job ; le mapping est validé", async () => {
    rpc.mockResolvedValue({ data: { status: "running", path: `${ORG}/${BATCH}.csv`, mapping: { email: 1 }, default_country: "MA", project_id: PROJECT }, error: null });
    expect(await gateway.start(ORG, BATCH)).toEqual({ status: "running", path: `${ORG}/${BATCH}.csv`, mapping: { email: 1 }, defaultCountry: "MA", projectId: PROJECT });
    expect(rpc).toHaveBeenCalledWith("import_start", { p_org: ORG, p_batch: BATCH });
    rpc.mockResolvedValue({ data: { status: "done" }, error: null });
    expect(await gateway.start(ORG, BATCH)).toEqual({ status: "done" });
    rpc.mockResolvedValue({ data: { status: "running", path: "x", mapping: { name: 0 }, default_country: null, project_id: PROJECT }, error: null });
    await expect(gateway.start(ORG, BATCH)).rejects.toThrow("import_start_failed");
  });

  it("row : valeurs normalisées transmises, résultat validé ; erreur d'abonnement reconnue, jamais de message brut", async () => {
    rpc.mockResolvedValue({ data: { outcome: "created", reason: null, lead_created: true }, error: null });
    expect(await gateway.row(ORG, BATCH, 2, value)).toEqual({ outcome: "created", reason: null, leadCreated: true });
    expect(rpc).toHaveBeenCalledWith("import_row", {
      p_org: ORG, p_batch: BATCH, p_row: 2, p_name: "Nadia", p_email_raw: "Nadia@x.com", p_email_normalized: "nadia@x.com", p_phone_e164: null, p_language: "fr", p_country: "MA",
    });
    rpc.mockResolvedValue({ data: null, error: { message: "subscription_inactive for nadia@x.com" } });
    const error = await gateway.row(ORG, BATCH, 3, value).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportGatewayError);
    expect((error as ImportGatewayError).kind).toBe("subscription_inactive");
    expect((error as Error).message).toBe("import_row_failed");
    rpc.mockResolvedValue({ data: null, error: { message: "autre panne, nadia@x.com" } });
    const other = (await gateway.row(ORG, BATCH, 3, value).catch((e: unknown) => e)) as ImportGatewayError;
    expect(other.kind).toBe("failed");
    expect(other.message).not.toContain("nadia");
    rpc.mockResolvedValue({ data: { outcome: "?" }, error: null });
    await expect(gateway.row(ORG, BATCH, 4, value)).rejects.toThrow("import_row_failed");
  });

  it("rowError, finish, fail : fonctions SQL avec l'entreprise du job ; panne = erreur générique", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await gateway.rowError(ORG, BATCH, 5, "invalid_email");
    await gateway.finish(ORG, BATCH, 7);
    await gateway.fail(ORG, BATCH, "file_missing");
    expect(rpc.mock.calls.map((call) => call[0])).toEqual(["import_record_error", "import_finish", "import_fail"]);
    expect(rpc).toHaveBeenCalledWith("import_finish", { p_org: ORG, p_batch: BATCH, p_rows: 7 });
    rpc.mockResolvedValue({ data: null, error: { message: "secret" } });
    await expect(gateway.finish(ORG, BATCH, 7)).rejects.toThrow("import_finish_failed");
  });

  it("readFile : octets du Storage ; fichier absent = null ; autre panne = erreur générique", async () => {
    download.mockResolvedValue({ data: { arrayBuffer: async () => new Uint8Array([97, 98]).buffer }, error: null });
    expect(await gateway.readFile(`${ORG}/${BATCH}.csv`)).toEqual(new Uint8Array([97, 98]));
    download.mockResolvedValue({ data: null, error: { message: "Object not found", statusCode: "404" } });
    expect(await gateway.readFile(`${ORG}/${BATCH}.csv`)).toBeNull();
    download.mockResolvedValue({ data: null, error: { message: "boom", statusCode: "500" } });
    await expect(gateway.readFile(`${ORG}/${BATCH}.csv`)).rejects.toThrow("import_read_failed");
  });
});
