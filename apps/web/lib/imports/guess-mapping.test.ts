import { describe, expect, it } from "vitest";
import { guessMapping, normalizeHeader } from "./guess-mapping";

describe("proposition de correspondance des colonnes (J39c)", () => {
  it("normalise accents, casse, ponctuation et espaces", () => {
    expect(normalizeHeader(" E-mail ")).toBe("email");
    expect(normalizeHeader("Téléphone")).toBe("telephone");
    expect(normalizeHeader("Nom complet")).toBe("nomcomplet");
  });

  it("reconnaît des en-têtes français, anglais et arabes", () => {
    expect(guessMapping(["Nom", "E-mail", "Téléphone", "Langue", "Pays"])).toEqual({ name: 0, email: 1, phone: 2, language: 3, country: 4 });
    expect(guessMapping(["name", "email", "phone"])).toEqual({ name: 0, email: 1, phone: 2 });
    expect(guessMapping(["الاسم", "البريد", "الهاتف"])).toEqual({ name: 0, email: 1, phone: 2 });
  });

  it("ne propose rien pour des en-têtes inconnus et ne double jamais une colonne", () => {
    expect(guessMapping(["colonne a", "colonne b"])).toEqual({});
    const mapping = guessMapping(["email", "mail", "phone", "tel"]);
    const columns = Object.values(mapping);
    expect(new Set(columns).size).toBe(columns.length);
    expect(mapping).toEqual({ email: 0, phone: 2 });
  });

  it("un en-tête vide ou en double ne casse rien", () => {
    expect(guessMapping([])).toEqual({});
    expect(guessMapping(["", "", "email"])).toEqual({ email: 2 });
  });
});
