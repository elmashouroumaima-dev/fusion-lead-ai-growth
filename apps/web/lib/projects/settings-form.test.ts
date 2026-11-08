import { parseProjectSettings, PROJECT_TYPES } from "@fusion-leap/domain";
import { describe, expect, it } from "vitest";
import { cleanSettings, linesToList, listToLines, settingsToFormState } from "./settings-form";

describe("listes multilignes", () => {
  it("une ligne par élément ; lignes vides et espaces retirés ; fins de ligne Windows acceptées", () => {
    expect(linesToList("  Pack vitrine \r\n\r\n Pack boutique\n   \n")).toEqual(["Pack vitrine", "Pack boutique"]);
    expect(linesToList("")).toEqual([]);
  });

  it("liste -> texte, valeurs non textuelles ignorées", () => {
    expect(listToLines(["a", "b"])).toBe("a\nb");
    expect(listToLines(["a", 3, null, "b"])).toBe("a\nb");
    expect(listToLines(undefined)).toBe("");
  });
});

describe("cleanSettings", () => {
  it("website_sales : textes rognés, listes issues du texte, lignes vides retirées", () => {
    const cleaned = cleanSettings("website_sales", {
      offers: "Pack vitrine\n\nPack boutique ",
      business_models: "",
      target_market: "  PME marocaines ",
      landing_pages: [
        { name: "Accueil", url: " https://exemple.test/lp " },
        { name: "", url: "" },
      ],
    });
    expect(cleaned).toEqual({
      offers: ["Pack vitrine", "Pack boutique"],
      target_market: "PME marocaines",
      landing_pages: [{ name: "Accueil", url: "https://exemple.test/lp" }],
    });
  });

  it("une ligne à moitié remplie est conservée (zod la refusera avec un message)", () => {
    expect(cleanSettings("website_sales", { landing_pages: [{ name: "Seulement un nom", url: "" }] })).toEqual({
      landing_pages: [{ name: "Seulement un nom", url: "" }],
    });
  });

  it("salla_app : FAQ en lignes, champs vides supprimés", () => {
    const cleaned = cleanSettings("salla_app", {
      app_name: "Relance",
      problem_solved: "   ",
      store_url: "https://exemple.test/app",
      merchant_segments: "mode\nbeauté",
      faqs: [{ question: "Prix ?", answer: "Voir les formules." }, { question: "", answer: "" }],
    });
    expect(cleaned).toEqual({
      app_name: "Relance",
      store_url: "https://exemple.test/app",
      merchant_segments: ["mode", "beauté"],
      faqs: [{ question: "Prix ?", answer: "Voir les formules." }],
    });
  });

  it("salla_theme : aperçu et listes", () => {
    expect(cleanSettings("salla_theme", { preview_url: "https://exemple.test/t", sectors: "mode", features: "rapide\nléger" })).toEqual({
      preview_url: "https://exemple.test/t",
      sectors: ["mode"],
      features: ["rapide", "léger"],
    });
  });

  it("custom : lignes clé / valeur -> objet `fields`", () => {
    expect(cleanSettings("custom", { notes: " libre ", fields_rows: [{ key: "budget", value: "5 000" }, { key: "", value: "" }] })).toEqual({
      notes: "libre",
      fields: { budget: "5 000" },
    });
    expect(cleanSettings("custom", { fields_rows: [] })).toEqual({});
  });

  it("ignore les clés d'un autre type (aucun réglage inconnu n'est envoyé)", () => {
    expect(cleanSettings("salla_theme", { offers: "x", app_name: "y", target_market: "z" })).toEqual({});
  });

  it("le résultat est accepté par le schéma du domaine pour chaque type", () => {
    const samples = {
      website_sales: { offers: "a\nb", target_market: "PME", landing_pages: [{ name: "n", url: "https://exemple.test/x" }] },
      salla_app: { app_name: "A", store_url: "https://exemple.test/app", faqs: [{ question: "q", answer: "a" }] },
      salla_theme: { preview_url: "https://exemple.test/theme", sectors: "mode" },
      custom: { notes: "n", fields_rows: [{ key: "budget", value: "1" }] },
    } as const;
    for (const type of PROJECT_TYPES) {
      expect(parseProjectSettings(type, cleanSettings(type, samples[type])).success, type).toBe(true);
    }
  });
});

describe("settingsToFormState (aller-retour)", () => {
  it("les listes deviennent du texte multiligne et `fields` des lignes clé / valeur ; nettoyage inverse identique", () => {
    const saved = { offers: ["Pack vitrine", "Pack boutique"], target_market: "PME" };
    const state = settingsToFormState("website_sales", saved);
    expect(state.offers).toBe("Pack vitrine\nPack boutique");
    expect(cleanSettings("website_sales", state)).toEqual(saved);

    const custom = { notes: "n", fields: { budget: "5 000", canal: "email" } };
    const customState = settingsToFormState("custom", custom);
    expect(customState.fields_rows).toEqual([{ key: "budget", value: "5 000" }, { key: "canal", value: "email" }]);
    expect(cleanSettings("custom", customState)).toEqual(custom);
  });

  it("réglages absents ou vides : état vide, sans plantage", () => {
    expect(settingsToFormState("custom", {}).fields_rows).toEqual([]);
    expect(cleanSettings("salla_app", settingsToFormState("salla_app", {}))).toEqual({});
  });
});
