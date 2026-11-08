import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { importRowKeys, normalizeImportRow, parseCsv } from "./index";

/**
 * Fixture `tests/fixtures/leads-100.csv` (plan J23, scénario 2 de la spec §13) : 100 lignes avec doublons et téléphones marocains et
 * saoudiens de formats variés. Ce test fige ce que le domaine en tire ; l'acceptation (HTTP + worker) vérifie les mêmes chiffres en base.
 */
const FIXTURE = fileURLToPath(new URL("../../../../tests/fixtures/leads-100.csv", import.meta.url));
const mapping = { name: 0, email: 1, phone: 2, language: 3, country: 4 };

describe("leads-100.csv", () => {
  const rows = parseCsv(readFileSync(FIXTURE, "utf8"));

  it("un en-tête et 100 lignes ; les noms avec virgule et les noms arabes sont lus tels quels", () => {
    expect(rows).toHaveLength(101);
    expect(rows[0]).toEqual(["Nom", "Email", "Téléphone", "Langue", "Pays"]);
    expect(rows.some((cells) => cells[0] === "Benali, Nadia 10")).toBe(true);
    expect(rows.some((cells) => cells[0] === "سارة المنصوري")).toBe(true);
  });

  it("65 lignes nouvelles, 15 doublons dans le fichier, 2 contacts déjà connus, 18 erreurs (pays par défaut MA)", () => {
    const seen = new Set<string>();
    const counts = { fresh: 0, duplicate: 0, errors: {} as Record<string, number> };
    for (const cells of rows.slice(1)) {
      const result = normalizeImportRow(cells, mapping, "MA");
      if (!result.ok) {
        counts.errors[result.reason] = (counts.errors[result.reason] ?? 0) + 1;
        continue;
      }
      const keys = importRowKeys(result.value);
      if (keys.some((key) => seen.has(key))) counts.duplicate += 1;
      else counts.fresh += 1;
      for (const key of keys) seen.add(key);
    }
    expect(counts.errors).toEqual({ no_identifier: 5, invalid_email: 5, invalid_phone: 5, invalid_language: 3 });
    expect(counts.duplicate).toBe(15);
    // 65 nouveaux + les 2 contacts « déjà connus » (créés avant l'import par l'acceptation) comptent ici comme des lignes nouvelles
    expect(counts.fresh).toBe(67);
  });

  it("téléphones hétérogènes normalisés en E.164 (national, +212, 00212, points, +966, 00966)", () => {
    const phones = rows.slice(1, 61).map((cells) => normalizeImportRow(cells, mapping, "MA")).map((r) => (r.ok ? r.value.phone_e164 : null));
    expect(phones.every((p) => p !== null && /^\+(212|966)[0-9]{9}$/.test(p))).toBe(true);
    expect(phones.filter((p) => p?.startsWith("+966")).length).toBeGreaterThan(5);
  });
});
