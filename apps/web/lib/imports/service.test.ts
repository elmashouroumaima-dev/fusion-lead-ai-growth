import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSupabase } from "../tenant/identity";
import { cancelImport, confirmImport, getImportReport, previewImport, uploadImport } from "./service";

const ORG = "bb000000-0000-4000-8000-00000000000a";
const PROJECT = "cc000000-0000-4000-8000-0000000000a1";
const BATCH = "ee000000-0000-4000-8000-000000000001";
const NOW = "2026-11-25T10:00:00+00:00";
const csv = (text: string) => new TextEncoder().encode(text);

type StorageError = { message: string; statusCode?: string } | null;

function fakeClient() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const state = {
    uploadError: null as StorageError,
    downloadError: null as StorageError,
    file: csv("nom,email\nA,a@x.com\n") as Uint8Array | null,
    rpc: ((): { data: unknown; error: unknown } => ({ data: null, error: null })) as (name: string, args: Record<string, unknown>) => { data: unknown; error: unknown },
    batch: null as unknown,
    rows: [] as unknown[],
    dbError: null as unknown,
  };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ op: `rpc:${name}`, args: [args] });
    return state.rpc(name, args);
  });
  const storage = {
    from: (bucket: string) => ({
      upload: async (path: string, bytes: Uint8Array, options: unknown) => {
        calls.push({ op: "upload", args: [bucket, path, bytes.byteLength, options] });
        return { data: state.uploadError ? null : { path }, error: state.uploadError };
      },
      remove: async (paths: string[]) => {
        calls.push({ op: "remove", args: [bucket, paths] });
        return { data: [], error: null };
      },
      download: async (path: string) => {
        calls.push({ op: "download", args: [bucket, path] });
        if (state.downloadError || !state.file) return { data: null, error: state.downloadError ?? { message: "x" } };
        const bytes = state.file;
        return { data: { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }, error: null };
      },
    }),
  };
  const from = (table: string) => {
    const query: Record<string, unknown> = {};
    let window: [number, number] | null = null;
    for (const method of ["select", "eq", "order", "range"]) {
      query[method] = (...args: unknown[]) => {
        calls.push({ op: `${table}.${method}`, args });
        if (method === "range") window = [args[0] as number, args[1] as number];
        return query;
      };
    }
    query.maybeSingle = async () => ({ data: state.batch, error: state.dbError });
    // l'API plafonne chaque réponse à 1000 lignes, comme PostgREST (max_rows)
    query.then = (resolve: (value: unknown) => unknown) => {
      const rows = window ? state.rows.slice(window[0], Math.min(window[1] + 1, window[0] + 1000)) : state.rows;
      return Promise.resolve({ data: rows, error: state.dbError }).then(resolve);
    };
    return query;
  };
  return { client: { rpc, storage, from } as unknown as ServerSupabase, rpc, state, calls };
}

const batchRow = (status: string) => ({
  id: BATCH, organization_id: ORG, project_id: PROJECT, status, file_size: 100, row_count: null, created_count: 0, matched_count: 0,
  skipped_count: 0, error_count: 0, error_code: null, created_at: NOW, updated_at: NOW, started_at: null, finished_at: null,
});

let c: ReturnType<typeof fakeClient>;
beforeEach(() => {
  c = fakeClient();
});

describe("uploadImport", () => {
  it("envoie au Storage privé sous un chemin GÉNÉRÉ {entreprise}/{lot}.csv puis enregistre le lot ; l'en-tête est renvoyé", async () => {
    const result = await uploadImport(c.client, ORG, { projectId: PROJECT, bytes: csv("Nom,Email\nA,a@x.com\nB,b@x.com\n") });
    expect(result.ok && result.value).toMatchObject({ rowCount: 2, columns: ["Nom", "Email"] });
    const upload = c.calls.find((call) => call.op === "upload");
    const path = upload?.args[1] as string;
    expect(upload?.args[0]).toBe("imports");
    expect(path).toMatch(new RegExp(`^${ORG}/[0-9a-f-]{36}\\.csv$`));
    expect(upload?.args[3]).toEqual({ contentType: "text/csv", upsert: false });
    expect(c.rpc).toHaveBeenCalledWith("create_import_batch", { p_org: ORG, p_project: PROJECT, p_path: path, p_size: 30 });
  });

  it("fichier vide, sans ligne, UTF-8 invalide, trop de colonnes, guillemet ouvert : validation_failed, rien d'envoyé", async () => {
    for (const bytes of [new Uint8Array(0), csv("nom,email\n"), new Uint8Array([0x6e, 0x0a, 0xff, 0xfe, 0x0a]), csv(`${Array.from({ length: 51 }, () => "x").join(",")}\na`), csv('a,"b\nc')]) {
      expect(await uploadImport(c.client, ORG, { projectId: PROJECT, bytes })).toEqual({ ok: false, code: "validation_failed" });
    }
    expect(c.calls.some((call) => call.op === "upload")).toBe(false);
  });

  it("plus de 10 Mo : payload_too_large ; plus de 10 000 lignes : validation_failed", async () => {
    expect(await uploadImport(c.client, ORG, { projectId: PROJECT, bytes: new Uint8Array(10 * 1024 * 1024 + 1) })).toEqual({ ok: false, code: "payload_too_large" });
    const many = csv(`email\n${Array.from({ length: 10_001 }, (_, i) => `u${i}@x.com`).join("\n")}\n`);
    expect(await uploadImport(c.client, ORG, { projectId: PROJECT, bytes: many })).toEqual({ ok: false, code: "validation_failed" });
  });

  it("refus Storage (politique) : forbidden ; la base n'est pas appelée", async () => {
    c.state.uploadError = { message: "new row violates row-level security policy", statusCode: "403" };
    expect(await uploadImport(c.client, ORG, { projectId: PROJECT, bytes: csv("e\na@x.com\n") })).toEqual({ ok: false, code: "forbidden" });
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it("échec d'enregistrement du lot : le fichier envoyé est retiré ; erreur de la base traduite en code", async () => {
    c.state.rpc = () => ({ data: null, error: { code: "P0001", message: "too_many_imports" } });
    expect(await uploadImport(c.client, ORG, { projectId: PROJECT, bytes: csv("e\na@x.com\n") })).toEqual({ ok: false, code: "conflict" });
    expect(c.calls.some((call) => call.op === "remove")).toBe(true);
    c.state.rpc = () => ({ data: null, error: { code: "42501", message: "forbidden" } });
    expect(await uploadImport(c.client, ORG, { projectId: PROJECT, bytes: csv("e\na@x.com\n") })).toEqual({ ok: false, code: "forbidden" });
  });
});

describe("previewImport", () => {
  const mapping = { name: 0, email: 1, phone: 2 };
  const input = { batch_id: BATCH, mapping, default_country: "MA" };
  const file = "nom,email,tel\nA,a@x.com,\nB,b@x.com,0612345678\nC,A@x.com,\nD,,\nE,mauvais,\nF,connu@x.com,\n";

  beforeEach(() => {
    c.state.batch = batchRow("uploaded");
    c.state.file = csv(file);
    c.state.rpc = (name) => (name === "import_dedup_check" ? { data: { emails: ["connu@x.com"], phones: [] }, error: null } : { data: null, error: null });
  });

  it("rapport : nouveaux, déjà connus, doublons dans le fichier, erreurs avec motif ; aperçu des lignes", async () => {
    const result = await previewImport(c.client, ORG, input);
    expect(result.ok && result.value).toMatchObject({
      rowCount: 6, valid: 4, newContacts: 2, existingContacts: 1, duplicatesInFile: 1, errors: 2,
      errorsByReason: { no_identifier: 1, invalid_email: 1 },
      errorRows: [{ rowNo: 5, reason: "no_identifier" }, { rowNo: 6, reason: "invalid_email" }],
    });
    const rows = result.ok ? result.value.rows : [];
    expect(rows.map((row) => row.status)).toEqual(["new", "new", "duplicate_in_file", "error", "error", "existing"]);
    expect(rows[0]).toMatchObject({ rowNo: 2, cells: ["A", "a@x.com", ""] });
  });

  it("N'ÉCRIT RIEN : seule la lecture de dédup est appelée (ni création de contact, ni confirmation)", async () => {
    await previewImport(c.client, ORG, input);
    const rpcs = c.calls.filter((call) => call.op.startsWith("rpc:")).map((call) => call.op);
    expect(rpcs).toEqual(["rpc:import_dedup_check"]);
    expect(c.calls.some((call) => call.op === "upload" || call.op === "remove")).toBe(false);
  });

  it("les adresses valides sont envoyées normalisées, entreprise du contexte", async () => {
    await previewImport(c.client, ORG, input);
    const args = c.calls.find((call) => call.op === "rpc:import_dedup_check")?.args[0] as { p_org: string; p_emails: string[]; p_phones: string[] };
    expect(args.p_org).toBe(ORG);
    expect(args.p_emails.sort()).toEqual(["a@x.com", "b@x.com", "connu@x.com"]);
    expect(args.p_phones).toEqual(["+212612345678"]);
  });

  it("aperçu limité à 20 lignes ; le fichier est lu sous le chemin de l'entreprise du contexte", async () => {
    c.state.file = csv(`nom,email\n${Array.from({ length: 30 }, (_, i) => `N${i},u${i}@x.com`).join("\n")}\n`);
    const result = await previewImport(c.client, ORG, { ...input, mapping: { name: 0, email: 1 } });
    expect(result.ok && result.value.rows).toHaveLength(20);
    expect(result.ok && result.value.rowCount).toBe(30);
    expect(c.calls.find((call) => call.op === "download")?.args).toEqual(["imports", `${ORG}/${BATCH}.csv`]);
  });

  it("lot inconnu : not_found ; lot déjà confirmé : conflict ; fichier illisible : validation_failed ; panne de dédup : internal_error", async () => {
    c.state.batch = null;
    expect(await previewImport(c.client, ORG, input)).toEqual({ ok: false, code: "not_found" });
    c.state.batch = batchRow("queued");
    expect(await previewImport(c.client, ORG, input)).toEqual({ ok: false, code: "conflict" });
    c.state.batch = batchRow("uploaded");
    c.state.file = new Uint8Array([0xff, 0xfe]);
    expect(await previewImport(c.client, ORG, input)).toEqual({ ok: false, code: "validation_failed" });
    c.state.file = csv(file);
    c.state.rpc = () => ({ data: null, error: { message: "boom" } });
    expect(await previewImport(c.client, ORG, input)).toEqual({ ok: false, code: "internal_error" });
  });
});

describe("confirmImport et cancelImport", () => {
  beforeEach(() => {
    c.state.batch = batchRow("uploaded");
  });

  it("lot inconnu : not_found ; lot déjà confirmé, annulé ou terminé : conflict, sans lire le fichier", async () => {
    const input = { batch_id: BATCH, mapping: { email: 1 }, default_country: null };
    c.state.batch = null;
    expect(await confirmImport(c.client, ORG, input)).toEqual({ ok: false, code: "not_found" });
    for (const status of ["queued", "running", "done", "cancelled", "failed"]) {
      c.state.batch = batchRow(status);
      expect(await confirmImport(c.client, ORG, input), status).toEqual({ ok: false, code: "conflict" });
    }
    expect(c.calls.some((call) => call.op === "download")).toBe(false);
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it("confirmation : relit le fichier, compte les lignes, appelle la fonction avec l'entreprise du contexte", async () => {
    c.state.file = csv("nom,email\nA,a@x.com\nB,b@x.com\n");
    expect(await confirmImport(c.client, ORG, { batch_id: BATCH, mapping: { email: 1 }, default_country: "MA" })).toEqual({ ok: true, value: true });
    expect(c.rpc).toHaveBeenCalledWith("confirm_import", { p_org: ORG, p_batch: BATCH, p_mapping: { email: 1 }, p_default_country: "MA", p_rows: 2 });
  });

  it("lot déjà confirmé : conflict ; lot inconnu : not_found ; rôle : forbidden ; fichier absent : not_found", async () => {
    const input = { batch_id: BATCH, mapping: { email: 1 }, default_country: null };
    c.state.rpc = () => ({ data: null, error: { code: "P0001", message: "import_not_pending" } });
    expect(await confirmImport(c.client, ORG, input)).toEqual({ ok: false, code: "conflict" });
    c.state.rpc = () => ({ data: null, error: { code: "PT404", message: "not_found" } });
    expect(await confirmImport(c.client, ORG, input)).toEqual({ ok: false, code: "not_found" });
    c.state.rpc = () => ({ data: null, error: { code: "42501", message: "forbidden" } });
    expect(await confirmImport(c.client, ORG, input)).toEqual({ ok: false, code: "forbidden" });
    c.state.downloadError = { message: "Object not found", statusCode: "404" };
    expect(await confirmImport(c.client, ORG, input)).toEqual({ ok: false, code: "not_found" });
  });

  it("annulation : fonction avec l'entreprise du contexte ; lot déjà terminé : conflict", async () => {
    expect(await cancelImport(c.client, ORG, { batch_id: BATCH })).toEqual({ ok: true, value: true });
    expect(c.rpc).toHaveBeenCalledWith("cancel_import", { p_org: ORG, p_batch: BATCH });
    // le fichier (données personnelles) est retiré du Storage à l'annulation
    expect(c.calls).toContainEqual({ op: "remove", args: ["imports", [`${ORG}/${BATCH}.csv`]] });
    c.state.rpc = () => ({ data: null, error: { code: "P0001", message: "import_not_pending" } });
    expect(await cancelImport(c.client, ORG, { batch_id: BATCH })).toEqual({ ok: false, code: "conflict" });
  });
});

describe("getImportReport", () => {
  it("rapport par ligne, codes seulement ; colonnes lues limitées (jamais de contact_id)", async () => {
    c.state.batch = batchRow("done");
    c.state.rows = [{ row_no: 2, outcome: "created", reason: null, lead_created: true }];
    const report = await getImportReport(c.client, ORG, BATCH);
    expect(report?.rows).toEqual([{ row_no: 2, outcome: "created", reason: null, lead_created: true }]);
    const columns = c.calls.filter((call) => call.op === "import_rows.select").map((call) => call.args[0] as string);
    expect(columns.join(" ")).not.toContain("contact_id");
  });

  it("plus de 1000 lignes : le rapport se lit par blocs, complet et dans l'ordre (jamais tronqué en silence)", async () => {
    c.state.batch = batchRow("done");
    c.state.rows = Array.from({ length: 2500 }, (_, i) => ({ row_no: i + 2, outcome: "created", reason: null, lead_created: true }));
    const report = await getImportReport(c.client, ORG, BATCH);
    expect(report?.rows).toHaveLength(2500);
    expect(report?.rows[0]?.row_no).toBe(2);
    expect(report?.rows[2499]?.row_no).toBe(2501);
    expect(c.calls.filter((call) => call.op === "import_rows.range").map((call) => call.args)).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("lot inconnu (ou d'une autre entreprise) : null ; ligne illisible : erreur générique", async () => {
    c.state.batch = null;
    expect(await getImportReport(c.client, ORG, BATCH)).toBeNull();
    c.state.batch = batchRow("done");
    c.state.rows = [{ row_no: 2, outcome: "?", reason: null, lead_created: true }];
    await expect(getImportReport(c.client, ORG, BATCH)).rejects.toThrow("rows_unreadable");
  });
});
