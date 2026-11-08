import { describe, expect, it } from "vitest";
import { NonRetryableError } from "./errors";
import { createImportCsvHandler, type JobContext } from "./handlers";
import { MemoryImports } from "./imports.testkit";

const ORG = "11111111-1111-4111-8111-111111111111";
const BATCH = "66666666-6666-4666-8666-666666666666";
const ctx = (over: Partial<JobContext> = {}): JobContext => ({
  jobId: "44444444-4444-4444-8444-444444444444", organizationId: ORG, idempotencyKey: "k", attempt: 1, maxAttempts: 3, signal: new AbortController().signal, ...over,
});
const csv = (text: string) => new TextEncoder().encode(text);
const run = (gateway: MemoryImports, over: Partial<JobContext> = {}) => createImportCsvHandler(gateway).run(ctx(over), { batch_id: BATCH });

describe("import_csv : charge utile", () => {
  it("l'identifiant du lot seulement (aucun champ en plus, aucune entreprise)", () => {
    const handler = createImportCsvHandler(new MemoryImports());
    expect(handler.kind).toBe("import_csv");
    expect(handler.parse({ batch_id: BATCH }).success).toBe(true);
    expect(handler.parse({ batch_id: "x" }).success).toBe(false);
    expect(handler.parse({ batch_id: BATCH, organization_id: ORG }).success).toBe(false);
    expect(handler.parse({ batch_id: BATCH, rows: [] }).success).toBe(false);
  });
});

describe("import_csv : exécution", () => {
  it("lit le fichier ligne par ligne : lignes valides au rapport, lignes refusées en codes, numéros de ligne du fichier", async () => {
    const gateway = new MemoryImports();
    gateway.file = csv("nom,email,tel\r\nNadia,Nadia@X.com,0612345678\r\nSans identifiant,,\r\nMauvais,pas-un-email,\r\n\r\nSarah,sarah@x.com,\r\n");
    await run(gateway);
    expect([...gateway.rows.keys()]).toEqual([2, 5]);
    expect(gateway.values.get(2)).toMatchObject({ email_normalized: "nadia@x.com", phone_e164: "+212612345678" });
    expect(Object.fromEntries(gateway.errors)).toEqual({ 3: "no_identifier", 4: "invalid_email" });
    expect(gateway.finished).toEqual({ org: ORG, batch: BATCH, rows: 4 });
    expect(gateway.failed).toBeNull();
  });

  it("séparateur « ; », guillemets et BOM", async () => {
    const gateway = new MemoryImports();
    gateway.file = csv('﻿nom;email;tel\n"Benali; Nadia";nadia@x.com;\n');
    await run(gateway);
    expect(gateway.values.get(2)).toMatchObject({ name: "Benali; Nadia", email_normalized: "nadia@x.com" });
  });

  it("lot terminé, annulé ou inconnu : rien à faire (rejeu du job sans effet)", async () => {
    for (const status of ["done", "cancelled", "missing", "failed"] as const) {
      const gateway = new MemoryImports();
      gateway.startResult = { status };
      await run(gateway);
      expect(gateway.calls.read, status).toBe(0);
      expect(gateway.calls.row, status).toBe(0);
      expect(gateway.finished, status).toBeNull();
    }
  });

  it("rejeu après une panne : les lignes déjà enregistrées ne sont pas recréées, le lot se termine", async () => {
    const gateway = new MemoryImports();
    gateway.file = csv("nom,email,tel\nA,a@x.com,\nB,b@x.com,\nC,c@x.com,\n");
    gateway.failRowFrom = 4;
    await expect(run(gateway, { attempt: 1 })).rejects.toThrow("import_row_failed");
    expect([...gateway.rows.keys()]).toEqual([2, 3]);
    expect(gateway.failed).toBeNull();
    gateway.failRowFrom = null;
    await run(gateway, { attempt: 2 });
    expect([...gateway.rows.keys()]).toEqual([2, 3, 4]);
    expect(gateway.finished?.rows).toBe(3);
  });

  it("dernière tentative après une panne : le lot est marqué « failed » (jamais bloqué en cours)", async () => {
    const gateway = new MemoryImports();
    gateway.file = csv("nom,email,tel\nA,a@x.com,\n");
    gateway.failRowFrom = 2;
    await expect(run(gateway, { attempt: 3 })).rejects.toThrow("import_row_failed");
    expect(gateway.failed).toBe("failed");
  });

  it("échec du marquage « failed » : l'erreur d'origine reste celle du job", async () => {
    const gateway = new MemoryImports();
    gateway.failRowFrom = 2;
    gateway.failFail = true;
    await expect(run(gateway, { attempt: 3 })).rejects.toThrow("import_row_failed");
  });

  it("abonnement inactif : échec définitif, lot « failed » avec le code", async () => {
    const gateway = new MemoryImports();
    gateway.failRowFrom = 2;
    gateway.failKind = "subscription_inactive";
    await expect(run(gateway)).rejects.toEqual(expect.objectContaining({ name: "NonRetryableError", code: "subscription_inactive" }));
    expect(gateway.failed).toBe("subscription_inactive");
  });

  it("projet archivé : échec définitif, lot « failed » avec le code « project_archived »", async () => {
    const gateway = new MemoryImports();
    gateway.failRowFrom = 2;
    gateway.failKind = "project_archived";
    await expect(run(gateway)).rejects.toEqual(expect.objectContaining({ name: "NonRetryableError", code: "project_archived" }));
    expect(gateway.failed).toBe("project_archived");
  });

  it("fichier absent : échec définitif « file_missing »", async () => {
    const gateway = new MemoryImports();
    gateway.file = null;
    await expect(run(gateway)).rejects.toBeInstanceOf(NonRetryableError);
    expect(gateway.failed).toBe("file_missing");
  });

  it("fichier mal formé (UTF-8 invalide, guillemet jamais fermé) : échec définitif « file_malformed »", async () => {
    const invalid = new MemoryImports();
    invalid.file = new Uint8Array([0x6e, 0x6f, 0x6d, 0x0a, 0xff, 0xfe, 0x0a]);
    await expect(run(invalid)).rejects.toBeInstanceOf(NonRetryableError);
    expect(invalid.failed).toBe("file_malformed");
    const open = new MemoryImports();
    open.file = csv('nom,email\n"jamais fermé,a@x.com\n');
    await expect(run(open)).rejects.toBeInstanceOf(NonRetryableError);
    expect(open.failed).toBe("file_malformed");
  });

  it("plus de 10 000 lignes : échec définitif « too_many_rows », rien n'est écrit", async () => {
    const gateway = new MemoryImports();
    gateway.file = csv(`email\n${Array.from({ length: 10_001 }, (_, i) => `u${i}@x.com`).join("\n")}\n`);
    gateway.startResult = { ...(gateway.startResult as Extract<typeof gateway.startResult, { status: "running" }>), mapping: { email: 0 } };
    await expect(run(gateway)).rejects.toBeInstanceOf(NonRetryableError);
    expect(gateway.failed).toBe("too_many_rows");
    expect(gateway.calls.row).toBe(0);
  });

  it("signal d'arrêt (bail perdu) : le traitement s'interrompt", async () => {
    const gateway = new MemoryImports();
    const controller = new AbortController();
    controller.abort();
    await expect(run(gateway, { signal: controller.signal })).rejects.toThrow("aborted");
    expect(gateway.calls.row).toBe(0);
  });
});
