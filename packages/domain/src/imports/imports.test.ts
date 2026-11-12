import { describe, expect, it } from "vitest";
import {
  buildImportReportCsv,
  confirmImportSchema,
  CsvError,
  CsvParser,
  detectDelimiter,
  IMPORT_MAX_CELL_LENGTH,
  IMPORT_MAX_COLUMNS,
  importMappingSchema,
  importRowKeys,
  normalizeImportRow,
  parseCsv,
} from "./index";

const UUID = "7c000000-0000-4000-8000-000000000001";

describe("parseCsv", () => {
  it("lignes simples, CRLF, LF et CR ; dernière ligne sans retour ; lignes vides ignorées", () => {
    expect(parseCsv("a,b\r\n1,2\n3,4\r5,6")).toEqual([["a", "b"], ["1", "2"], ["3", "4"], ["5", "6"]]);
    expect(parseCsv("a,b\n\n\n1,2\n")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("")).toEqual([]);
  });

  it("guillemets : séparateur, guillemet doublé et retour à la ligne dans une cellule", () => {
    expect(parseCsv('"a,b","c ""d""","e\nf"\n1,2,3')).toEqual([["a,b", 'c "d"', "e\nf"], ["1", "2", "3"]]);
    expect(parseCsv('""\n"",x')).toEqual([[""], ["", "x"]]);
  });

  it("BOM retiré ; cellules vides conservées ; guillemet au milieu d'une cellule non citée = littéral", () => {
    expect(parseCsv("﻿nom,email\nA,\n,b@x.com")).toEqual([["nom", "email"], ["A", ""], ["", "b@x.com"]]);
    expect(parseCsv('5" rue,x')).toEqual([['5" rue', "x"]]);
  });

  it("délimiteur détecté : « ; » et tabulation ; les virgules entre guillemets ne comptent pas", () => {
    expect(detectDelimiter("nom;email;tel\n")).toBe(";");
    expect(detectDelimiter("nom\temail\ttel")).toBe("\t");
    expect(detectDelimiter('"a,b,c";d')).toBe(";");
    expect(detectDelimiter("nom,email")).toBe(",");
    expect(parseCsv("nom;email\nA;a@x.com")).toEqual([["nom", "email"], ["A", "a@x.com"]]);
  });

  it("en continu : le même résultat quel que soit le découpage en morceaux (y compris CRLF et guillemets coupés)", () => {
    const text = 'nom,note\r\n"A ""x""","l1\r\nl2"\r\nB,\r\n';
    const whole = parseCsv(text, ",");
    for (const size of [1, 2, 3, 5, 7, 64]) {
      const parser = new CsvParser(",");
      const rows: string[][] = [];
      for (let i = 0; i < text.length; i += size) rows.push(...parser.push(text.slice(i, i + size)));
      rows.push(...parser.end());
      expect(rows, `morceaux de ${size}`).toEqual(whole);
    }
  });

  it("limites : colonnes, cellule, lignes, guillemet jamais fermé", () => {
    expect(() => parseCsv(Array.from({ length: IMPORT_MAX_COLUMNS + 1 }, () => "x").join(","))).toThrow(CsvError);
    expect(() => parseCsv("x".repeat(IMPORT_MAX_CELL_LENGTH + 1))).toThrow(expect.objectContaining({ code: "cell_too_long" }));
    expect(() => parseCsv("a\nb\nc", ",", 2)).toThrow(expect.objectContaining({ code: "too_many_rows" }));
    expect(() => parseCsv('a,"jamais fermé\nb')).toThrow(expect.objectContaining({ code: "unterminated_quote" }));
    expect(parseCsv("a\nb", ",", 2)).toEqual([["a"], ["b"]]);
  });
});

describe("mapping", () => {
  it("e-mail ou téléphone obligatoire ; colonnes distinctes ; rang 0 à 49 ; champ inconnu refusé", () => {
    expect(importMappingSchema.safeParse({ email: 1 }).success).toBe(true);
    expect(importMappingSchema.safeParse({ phone: 0, name: 2 }).success).toBe(true);
    expect(importMappingSchema.safeParse({ name: 0 }).success).toBe(false);
    expect(importMappingSchema.safeParse({ email: 1, phone: 1 }).success).toBe(false);
    expect(importMappingSchema.safeParse({ email: 50 }).success).toBe(false);
    expect(importMappingSchema.safeParse({ email: -1 }).success).toBe(false);
    expect(importMappingSchema.safeParse({ email: 1, organization_id: UUID }).success).toBe(false);
  });

  it("confirmation : entreprise jamais acceptée dans le corps, pays par défaut en majuscules", () => {
    expect(confirmImportSchema.safeParse({ batch_id: UUID, mapping: { email: 0 }, default_country: "MA" }).success).toBe(true);
    expect(confirmImportSchema.safeParse({ batch_id: UUID, mapping: { email: 0 } }).success).toBe(true);
    expect(confirmImportSchema.safeParse({ batch_id: UUID, mapping: { email: 0 }, default_country: "ma" }).success).toBe(false);
    expect(confirmImportSchema.safeParse({ batch_id: UUID, mapping: { email: 0 }, organization_id: UUID }).success).toBe(false);
  });
});

describe("normalizeImportRow", () => {
  const mapping = { name: 0, email: 1, phone: 2, language: 3, country: 4 };

  it("mêmes règles que les contacts saisis : e-mail en minuscules, téléphones marocain et saoudien en E.164", () => {
    expect(normalizeImportRow(["Nadia", " Nadia@Exemple.MA ", "06 12 34 56 78", "FR", "ma"], mapping, "MA")).toEqual({
      ok: true,
      value: { name: "Nadia", email_raw: "Nadia@Exemple.MA", email_normalized: "nadia@exemple.ma", phone_e164: "+212612345678", language: "fr", country: "MA" },
    });
    const saudi = normalizeImportRow(["", "", "050 123 4567", "", ""], mapping, "SA");
    expect(saudi.ok && saudi.value.phone_e164).toBe("+966501234567");
    const international = normalizeImportRow(["", "", "00212612345678", "", ""], mapping, null);
    expect(international.ok && international.value.phone_e164).toBe("+212612345678");
  });

  it("refuse avec un motif, jamais de correction silencieuse", () => {
    expect(normalizeImportRow(["A", "", "", "", ""], mapping, "MA")).toEqual({ ok: false, reason: "no_identifier" });
    expect(normalizeImportRow(["A", "pas-un-email", "", "", ""], mapping, "MA")).toEqual({ ok: false, reason: "invalid_email" });
    expect(normalizeImportRow(["A", "", "123", "", ""], mapping, "MA")).toEqual({ ok: false, reason: "invalid_phone" });
    expect(normalizeImportRow(["A", "", "0612345678", "", ""], mapping, null)).toEqual({ ok: false, reason: "invalid_phone" });
    expect(normalizeImportRow(["A", "a@x.com", "", "fra", ""], mapping, null)).toEqual({ ok: false, reason: "invalid_language" });
    expect(normalizeImportRow(["A", "a@x.com", "", "", "MAR"], mapping, null)).toEqual({ ok: false, reason: "invalid_country" });
    expect(normalizeImportRow(["a؜b", "a@x.com", "", "", ""], mapping, null)).toEqual({ ok: false, reason: "invalid_name" });
    // e-mail invalide : refusé même si le téléphone est bon
    expect(normalizeImportRow(["A", "x", "0612345678", "", ""], mapping, "MA")).toEqual({ ok: false, reason: "invalid_email" });
  });

  it("colonne absente de la ligne : valeur vide ; clés de déduplication dans le fichier", () => {
    const row = normalizeImportRow(["A", "a@x.com"], mapping, null);
    expect(row.ok && importRowKeys(row.value)).toEqual(["e:a@x.com"]);
    const both = normalizeImportRow(["A", "a@x.com", "0612345678"], mapping, "MA");
    expect(both.ok && importRowKeys(both.value)).toEqual(["e:a@x.com", "p:+212612345678"]);
  });
});

describe("rapport", () => {
  it("CSV sans donnée de contact : numéro de ligne, résultat, motif, lead créé", () => {
    expect(
      buildImportReportCsv([
        { row_no: 2, outcome: "created", reason: null, lead_created: true },
        { row_no: 3, outcome: "error", reason: "invalid_email", lead_created: false },
      ]),
    ).toBe("row,outcome,reason,lead_created\r\n2,created,,yes\r\n3,error,invalid_email,no\r\n");
  });
});
