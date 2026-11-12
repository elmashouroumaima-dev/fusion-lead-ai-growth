import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, isDenied, ORG, PROJECT, psql, rowsOf, select, storage, type Persona } from "./harness";

/**
 * Import CSV par la Data API et l'API Storage réelles (J23) : bucket privé `imports` (owner et admin de l'entreprise du chemin, rien
 * pour les autres rôles, Beta ni anonyme), lots gérés par fonctions réservées à owner et admin (jamais d'écriture directe), colonnes
 * `file_path` et `mapping` illisibles, fonctions du worker réservées à service_role, isolation Alpha / Beta, rapport sans donnée de
 * contact. Ré-exécutable : fichiers, lots, contacts et leads de l'exécution nettoyés.
 */

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const email = (n: string) => `rlsimp-${run}-${n}@exemple.test`.toLowerCase();
const CSV = new TextEncoder().encode("nom,email\nA,a@x.test\n");
const rpc = (persona: Persona, fn: string, args: Record<string, unknown>) => api<unknown>(persona, "POST", `rpc/${fn}`, args);
const message = (result: { body: unknown }): string =>
  typeof result.body === "object" && result.body !== null && "message" in result.body ? String((result.body as { message: unknown }).message) : "";
const upload = (persona: Persona, path: string, contentType = "text/csv", body: Uint8Array = CSV) =>
  storage(persona, "POST", `object/imports/${path}`, body, { "Content-Type": contentType });
const pathOf = (org: string, batch: string) => `${org}/${batch}.csv`;

const created: { org: string; batch: string }[] = [];
const newBatchPath = (org: string = ORG.alpha) => {
  const batch = randomUUID();
  created.push({ org, batch });
  return { batch, path: pathOf(org, batch) };
};

const cleanup = () => {
  const paths = created.map((c) => `'${pathOf(c.org, c.batch)}'`).join(",");
  psql(`
    set session_replication_role = replica;
    delete from public.jobs where kind in ('import_csv', 'lead.assign') and (payload ->> 'batch_id' in (select id::text from public.import_batches where file_path like '%.csv' and created_at > now() - interval '1 day' and id::text in (${created.map((c) => `'${c.batch}'`).join(",") || "''"}))
      or payload ->> 'lead_id' in (select l.id::text from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized like 'rlsimp-${run}-%'));
    delete from public.import_rows where batch_id in (${created.map((c) => `'${c.batch}'`).join(",") || "'00000000-0000-4000-8000-000000000000'"});
    delete from public.import_batches where id in (${created.map((c) => `'${c.batch}'`).join(",") || "'00000000-0000-4000-8000-000000000000'"});
    delete from public.activities where lead_id in (select l.id from public.leads l join public.contacts c on c.id = l.contact_id where c.email_normalized like 'rlsimp-${run}-%');
    delete from public.leads where contact_id in (select id from public.contacts where email_normalized like 'rlsimp-${run}-%');
    delete from public.contacts where email_normalized like 'rlsimp-${run}-%';
  `);
  if (paths) psql(`set storage.allow_delete_query = 'true'; delete from storage.objects where bucket_id = 'imports' and name in (${paths});`);
};

beforeAll(cleanup);
afterAll(cleanup);

let batch = "";
let batchPath = "";

describe("Storage : bucket privé `imports`", () => {
  it("owner et admin d'Alpha envoient dans le dossier de leur entreprise ; analyste, commercial, marketing, Beta, sans adhésion, anonyme refusés", async () => {
    const first = newBatchPath();
    batch = first.batch;
    batchPath = first.path;
    expect((await upload("shared", batchPath)).status).toBe(200);
    expect((await upload("alphaAdmin", newBatchPath().path)).status).toBe(200);
    for (const persona of ["alphaAnalyst", "alphaSales", "alphaMarketing", "betaOwner", "nobody", "anon"] as const) {
      expect((await upload(persona, newBatchPath().path)).status, persona).toBeGreaterThanOrEqual(400);
    }
  });

  it("le dossier d'une autre entreprise et un chemin mal formé sont refusés, même pour un owner", async () => {
    expect((await upload("shared", newBatchPath(ORG.beta).path)).status).toBeGreaterThanOrEqual(400);
    expect((await upload("shared", `${ORG.alpha}/fichier.csv`)).status).toBeGreaterThanOrEqual(400);
  });

  it("types limités par le bucket : une image n'est pas acceptée", async () => {
    expect((await upload("shared", newBatchPath().path, "image/png")).status).toBeGreaterThanOrEqual(400);
  });

  it("lecture : owner et admin ; les autres rôles, Beta et anonyme n'obtiennent rien", async () => {
    for (const persona of ["shared", "alphaAdmin"] as const) {
      expect((await storage(persona, "GET", `object/authenticated/imports/${batchPath}`)).status, persona).toBe(200);
    }
    for (const persona of ["alphaMarketing", "alphaSales", "alphaAnalyst", "betaOwner", "nobody", "anon"] as const) {
      expect((await storage(persona, "GET", `object/authenticated/imports/${batchPath}`)).status, persona).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("lots : création, lecture, aucune écriture directe", () => {
  it("create_import_batch : owner et admin seulement ; fichier absent, chemin d'une autre entreprise, projet d'une autre entreprise refusés", async () => {
    for (const persona of ["alphaMarketing", "alphaSales", "alphaAnalyst", "betaOwner", "nobody"] as const) {
      const result = await rpc(persona, "create_import_batch", { p_org: ORG.alpha, p_project: PROJECT.alphaSite, p_path: batchPath, p_size: 20 });
      expect(message(result), persona).toBe("forbidden");
    }
    expect(message(await rpc("shared", "create_import_batch", { p_org: ORG.alpha, p_project: PROJECT.alphaSite, p_path: newBatchPath().path, p_size: 20 }))).toBe("validation_failed");
    expect(message(await rpc("shared", "create_import_batch", { p_org: ORG.alpha, p_project: PROJECT.betaShop, p_path: batchPath, p_size: 20 }))).toBe("not_found");
    const created1 = await rpc("shared", "create_import_batch", { p_org: ORG.alpha, p_project: PROJECT.alphaSite, p_path: batchPath, p_size: CSV.length });
    expect(created1.status).toBe(200);
    expect(created1.body).toBe(batch);
    // le même fichier ne s'enregistre pas deux fois
    expect((await rpc("shared", "create_import_batch", { p_org: ORG.alpha, p_project: PROJECT.alphaSite, p_path: batchPath, p_size: CSV.length })).status).toBe(409);
  });

  it("lecture : owner et admin voient le lot (sans chemin ni mapping) ; commercial, marketing, analyste, Beta et anon non", async () => {
    for (const persona of ["shared", "alphaAdmin"] as const) {
      const rows = rowsOf<{ id: string; status: string }>(await select(persona, `import_batches?id=eq.${batch}&select=id,status,row_count`));
      expect(rows.map((row) => row.id), persona).toEqual([batch]);
    }
    for (const persona of ["alphaSales", "alphaMarketing", "alphaAnalyst", "betaOwner"] as const) {
      expect(rowsOf(await select(persona, `import_batches?id=eq.${batch}&select=id`)), persona).toEqual([]);
    }
    expect(isDenied(await select("anon", "import_batches?select=id"))).toBe(true);
    // colonnes sensibles : jamais lisibles par un utilisateur, même owner
    for (const column of ["file_path", "mapping"]) {
      const result = await select("shared", `import_batches?id=eq.${batch}&select=${column}`);
      expect(result.status, column).toBeGreaterThanOrEqual(400);
    }
  });

  it("aucune écriture directe, pas même par owner ou service_role", async () => {
    for (const persona of ["shared", "service"] as const) {
      const insert = await api<unknown>(persona, "POST", "import_batches", {
        id: randomUUID(), organization_id: ORG.alpha, project_id: PROJECT.alphaSite, file_path: "x", file_size: 1,
      });
      expect(insert.status, persona).not.toBe(201);
      const update = await api<unknown>(persona, "PATCH", `import_batches?id=eq.${batch}`, { status: "done" });
      expect(rowsOf(update), persona).toEqual([]);
      expect((await api<unknown>(persona, "POST", "import_rows", { organization_id: ORG.alpha, batch_id: batch, row_no: 2, outcome: "created" })).status, persona).not.toBe(201);
    }
  });
});

describe("confirmation, worker et isolation", () => {
  it("confirmation : mapping invalide refusé ; owner confirme ; un autre rôle ou une autre entreprise ne peut ni confirmer ni annuler", async () => {
    const args = { p_org: ORG.alpha, p_batch: batch, p_mapping: { email: 1 }, p_default_country: "MA", p_rows: 1 };
    expect(message(await rpc("shared", "confirm_import", { ...args, p_mapping: { name: 0 } }))).toBe("validation_failed");
    for (const persona of ["alphaMarketing", "alphaSales", "betaOwner"] as const) {
      expect(message(await rpc(persona, "confirm_import", args)), persona).toBe("forbidden");
      expect(message(await rpc(persona, "cancel_import", { p_org: ORG.alpha, p_batch: batch })), persona).toBe("forbidden");
    }
    // Beta qui se déclare dans SA propre entreprise : le lot d'Alpha est introuvable
    expect(message(await rpc("betaOwner", "confirm_import", { ...args, p_org: ORG.beta }))).toBe("not_found");
    expect((await rpc("alphaAdmin", "confirm_import", args)).status).toBe(204);
    expect(message(await rpc("shared", "confirm_import", args))).toBe("import_not_pending");
    const job = psql(`select payload::text from public.jobs where kind = 'import_csv' and payload ->> 'batch_id' = '${batch}'`);
    expect(JSON.parse(job)).toEqual({ batch_id: batch });
  });

  it("fonctions du worker : service_role seulement (ni anon, ni utilisateur connecté)", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["import_start", { p_org: ORG.alpha, p_batch: batch }],
      ["import_row", { p_org: ORG.alpha, p_batch: batch, p_row: 2, p_name: null, p_email_raw: email("deny"), p_email_normalized: email("deny"), p_phone_e164: null, p_language: null, p_country: null }],
      ["import_record_error", { p_org: ORG.alpha, p_batch: batch, p_row: 2, p_reason: "invalid_email" }],
      ["import_finish", { p_org: ORG.alpha, p_batch: batch, p_rows: 1 }],
      ["import_fail", { p_org: ORG.alpha, p_batch: batch, p_code: "failed" }],
    ];
    for (const [fn, args] of calls) {
      for (const persona of ["anon", "shared", "alphaAdmin", "betaOwner"] as const) {
        expect((await rpc(persona, fn, args)).status === 200 || (await rpc(persona, fn, args)).status === 204, `${fn} / ${persona}`).toBe(false);
      }
    }
    expect(psql(`select count(*) from public.contacts where email_normalized = '${email("deny")}'`)).toBe("0");
  });

  it("worker : lignes, rejeu, entreprise de la ligne du job (Beta ne touche pas le lot d'Alpha), rapport sans donnée de contact", async () => {
    expect((await rpc("service", "import_start", { p_org: ORG.beta, p_batch: batch })).body).toEqual({ status: "missing" });
    const started = (await rpc("service", "import_start", { p_org: ORG.alpha, p_batch: batch })).body as { status: string; default_country: string };
    expect(started).toMatchObject({ status: "running", default_country: "MA" });
    const row = (n: number, address: string) => ({
      p_org: ORG.alpha, p_batch: batch, p_row: n, p_name: "Test RLS import", p_email_raw: address, p_email_normalized: address, p_phone_e164: null, p_language: "fr", p_country: "MA",
    });
    expect((await rpc("service", "import_row", row(2, email("one")))).body).toEqual({ outcome: "created", reason: null, lead_created: true });
    expect((await rpc("service", "import_row", row(2, email("one")))).body).toEqual({ outcome: "created", reason: null, lead_created: true });
    expect((await rpc("service", "import_row", row(3, email("one")))).body).toEqual({ outcome: "matched", reason: "duplicate_in_file", lead_created: false });
    expect(message(await rpc("service", "import_row", { ...row(4, email("two")), p_org: ORG.beta }))).toBe("import_not_running");
    expect((await rpc("service", "import_record_error", { p_org: ORG.alpha, p_batch: batch, p_row: 4, p_reason: "invalid_phone" })).status).toBe(204);
    expect((await rpc("service", "import_finish", { p_org: ORG.alpha, p_batch: batch, p_rows: 3 })).status).toBe(204);
    expect(psql(`select count(*) from public.contacts where email_normalized = '${email("one")}'`)).toBe("1");
    expect(psql(`select count(*) from public.consent_events c join public.contacts k on k.id = c.contact_id where k.email_normalized = '${email("one")}'`)).toBe("0");

    const batchRow = rowsOf<{ status: string; created_count: number; matched_count: number; error_count: number }>(
      await select("shared", `import_batches?id=eq.${batch}&select=status,created_count,matched_count,error_count`),
    )[0];
    expect(batchRow).toEqual({ status: "done", created_count: 1, matched_count: 1, error_count: 1 });
    const report = rowsOf<Record<string, unknown>>(await select("alphaAdmin", `import_rows?batch_id=eq.${batch}&select=row_no,outcome,reason,lead_created&order=row_no`));
    expect(report.map((r) => `${String(r.row_no)}:${String(r.outcome)}:${String(r.reason ?? "")}`)).toEqual(["2:created:", "3:matched:duplicate_in_file", "4:error:invalid_phone"]);
    expect(JSON.stringify(report)).not.toContain("@");
    expect("contact_id" in (report[0] as object)).toBe(false);
    for (const persona of ["alphaSales", "alphaMarketing", "alphaAnalyst", "betaOwner"] as const) {
      expect(rowsOf(await select(persona, `import_rows?batch_id=eq.${batch}`)), persona).toEqual([]);
    }
    expect((await select("shared", `import_rows?batch_id=eq.${batch}&select=contact_id`)).status).toBeGreaterThanOrEqual(400);
  });
});
