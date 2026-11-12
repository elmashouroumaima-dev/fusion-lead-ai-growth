import type { CrmMappingEntry } from "@fusion-leap/domain";
import { describe, expect, it } from "vitest";
import { CsvCrmAdapter, InternalCrmAdapter, type CrmAdapter, type CrmRecord } from "./index";

const entry = (internal_field: CrmMappingEntry["internal_field"], external_field: string, direction: CrmMappingEntry["direction"] = "both"): CrmMappingEntry => ({
  entity: "contact", internal_field, external_field, source_of_truth: "internal", direction,
});
const mappings = [entry("external_id", "ID", "pull"), entry("external_updated_at", "Modifié le", "pull"), entry("name", "Nom"), entry("email", "E-mail", "pull"), entry("country", "Pays", "push")];

describe("contrat commun CrmAdapter", () => {
  const adapters: CrmAdapter[] = [new InternalCrmAdapter(), new CsvCrmAdapter(mappings)];

  it.each(adapters.map((a) => [a.provider, a] as const))("%s : connect, validate, refresh et disconnect répondent sans erreur", async (_provider, adapter) => {
    expect(await adapter.connect()).toEqual({ ok: true });
    expect(await adapter.validate()).toEqual({ ok: true });
    expect(await adapter.refresh()).toEqual({ ok: true });
    await expect(adapter.disconnect()).resolves.toBeUndefined();
  });
});

describe("InternalCrmAdapter : source de vérité, rien n'entre ni ne sort", () => {
  it("send n'envoie rien (tout est ignoré) ; receive ne rend rien", async () => {
    const adapter = new InternalCrmAdapter();
    const record: CrmRecord = { entity: "contact", externalId: "e1", fields: { name: "A" }, updatedAt: null };
    expect(await adapter.send([record, record])).toEqual({ accepted: 0, skipped: 2 });
    expect(await adapter.receive()).toEqual({ records: [], rejected: [], missingColumns: [] });
  });
});

describe("CsvCrmAdapter", () => {
  it("validate : sans colonne d'identifiant externe, mapping invalide", async () => {
    expect(await new CsvCrmAdapter([entry("name", "Nom")]).validate()).toEqual({ ok: false, code: "invalid_mapping" });
  });

  it("receive : lit selon les en-têtes du mapping, ignore les colonnes non mappées et le sens `push`, dates ISO", async () => {
    const text = "ID,Nom,E-mail,Pays,Modifié le,Inutile\r\nc1,Nadia,nadia@x.ma,MA,2026-11-12T10:00:00Z,x\r\nc2,,sarah@x.ma,SA,,y\r\n";
    const result = await new CsvCrmAdapter(mappings).receive({ text });
    expect(result.rejected).toEqual([]);
    expect(result.missingColumns).toEqual([]);
    expect(result.records).toEqual([
      { entity: "contact", externalId: "c1", fields: { name: "Nadia", email: "nadia@x.ma" }, updatedAt: new Date("2026-11-12T10:00:00Z") },
      { entity: "contact", externalId: "c2", fields: { name: null, email: "sarah@x.ma" }, updatedAt: null },
    ]);
  });

  it("receive : séparateur « ; », guillemets, BOM ; ligne sans identifiant ou date invalide : refusée avec son numéro, les autres passent", async () => {
    const text = '﻿ID;Nom;E-mail;Modifié le\n;Sans id;a@x.ma;\nc3;"Benali; Nadia";b@x.ma;pas-une-date\nc4;Ok;c@x.ma;2026-01-01\n';
    const result = await new CsvCrmAdapter(mappings).receive({ text });
    expect(result.rejected).toEqual([{ rowNo: 2, reason: "no_external_id" }, { rowNo: 3, reason: "invalid_date" }]);
    expect(result.records.map((r) => r.externalId)).toEqual(["c4"]);
  });

  it("receive : colonne absente du fichier : champ ignoré, jamais de plantage ; fichier sans ligne : rien", async () => {
    const result = await new CsvCrmAdapter(mappings).receive({ text: "ID\nc1\n" });
    expect(result.records).toEqual([{ entity: "contact", externalId: "c1", fields: {}, updatedAt: null }]);
    expect(await new CsvCrmAdapter(mappings).receive({ text: "" })).toMatchObject({ records: [], rejected: [] });
    // colonne d'identifiant absente de l'en-tête : signalée (le worker refuse la synchro)
    expect((await new CsvCrmAdapter(mappings).receive({ text: "Nom\nA\n" })).missingColumns).toContain("ID");
  });

  it("receive : dates ISO 8601 strictes seulement (« 01/02/2026 », « 5 » refusés)", async () => {
    const adapter = new CsvCrmAdapter(mappings);
    for (const bad of ["01/02/2026", "5", "2026-13-45", "demain", "2026-1-1"]) {
      expect((await adapter.receive({ text: `ID,Modifié le\nc1,${bad}\n` })).rejected, bad).toEqual([{ rowNo: 2, reason: "invalid_date" }]);
    }
    for (const good of ["2026-11-12", "2026-11-12T10:00:00Z", "2026-11-12 10:00:00+01:00", "2026-11-12T10:00"]) {
      expect((await adapter.receive({ text: `ID,Modifié le\nc1,${good}\n` })).records, good).toHaveLength(1);
    }
  });

  it("send : colonnes poussables seulement (identifiant + sens push ou both), formules neutralisées, CRLF", async () => {
    const adapter = new CsvCrmAdapter(mappings);
    const result = await adapter.send([
      { entity: "contact", externalId: "c1", fields: { name: "=cmd|calc", email: "secret@x.ma", country: "MA" }, updatedAt: null },
      { entity: "contact", externalId: "c2", fields: { name: "A, B" }, updatedAt: null },
    ]);
    expect(result).toEqual({ accepted: 2, skipped: 0, payload: "ID,Nom,Pays\r\nc1,'=cmd|calc,MA\r\nc2,\"A, B\",\r\n" });
    expect(result.payload).not.toContain("secret@x.ma");
  });

  it("aller-retour : ce que send écrit, receive le relit", async () => {
    const adapter = new CsvCrmAdapter([entry("external_id", "ID", "both"), entry("name", "Nom")]);
    const sent = await adapter.send([{ entity: "contact", externalId: "c9", fields: { name: "Sarah" }, updatedAt: null }]);
    expect((await adapter.receive({ text: sent.payload ?? "" })).records).toEqual([{ entity: "contact", externalId: "c9", fields: { name: "Sarah" }, updatedAt: null }]);
  });
});
