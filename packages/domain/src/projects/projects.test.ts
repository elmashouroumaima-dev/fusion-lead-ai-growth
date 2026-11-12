import { describe, expect, it } from "vitest";
import {
  assetPathSchema,
  createProductSchema,
  createProjectSchema,
  isSafeHttpsUrl,
  isSafeText,
  parseProjectSettings,
  productRowSchema,
  projectRowSchema,
  setProjectStatusSchema,
  updateProductSchema,
  updateProjectSchema,
  PROJECT_TYPES,
} from "./index";

const ORG = "7b000000-0000-4000-8000-00000000000a";
const PROJECT = "7c000000-0000-4000-8000-0000000000a1";
const OTHER = "7b000000-0000-4000-8000-00000000000b";

describe("textes sûrs (miroir de private.is_safe_text)", () => {
  it("accepte un texte normal, y compris arabe et accentué", () => {
    expect(isSafeText("Site vitrine", 1, 50)).toBe(true);
    expect(isSafeText("مشروع تجريبي", 1, 50)).toBe(true);
    expect(isSafeText("Création d’un thème", 1, 50)).toBe(true);
  });

  it("refuse vide, trop long, espaces en bordure", () => {
    expect(isSafeText("", 1, 5)).toBe(false);
    expect(isSafeText("abcdef", 1, 5)).toBe(false);
    expect(isSafeText(" a", 1, 5)).toBe(false);
    expect(isSafeText("a ", 1, 5)).toBe(false);
  });

  it("compte des caractères, pas des unités UTF-16", () => {
    expect(isSafeText("😀😀😀", 1, 3)).toBe(true);
    expect(isSafeText("😀😀😀😀", 1, 3)).toBe(false);
  });

  it("refuse contrôles, direction, séparateurs de ligne, BOM et caractères de balise", () => {
    for (const bad of ["a\u0000b", "a\u0007b", "a\u007fb", "a\u0085b", "a‮b", "a⁦b", "a​b", "a b", "a b", "a﻿b", "a\u{e0041}b", "a؜b", "a⁠b", "a­b", "a͏b", "a᠎b", "a️b", "aㅤb", "a\u{e0100}b", "a￼b"]) {
      expect(isSafeText(bad, 1, 20), JSON.stringify(bad)).toBe(false);
    }
  });

  it("saut de ligne et tabulation : seulement en texte multiligne", () => {
    expect(isSafeText("a\nb", 1, 20)).toBe(false);
    expect(isSafeText("a\nb\tc", 1, 20, true)).toBe(true);
    expect(isSafeText("a\u0001b", 1, 20, true)).toBe(false);
  });
});

describe("URL https (miroir de private.is_safe_https_url)", () => {
  it("accepte https avec port, chemin, requête et fragment", () => {
    expect(isSafeHttpsUrl("https://exemple.test")).toBe(true);
    expect(isSafeHttpsUrl("https://exemple.test:8443/p/q?utm_source=a&b=c#x")).toBe(true);
    expect(isSafeHttpsUrl("https://sous.domaine.exemple.test/")).toBe(true);
    expect(isSafeHttpsUrl("https://exemple.test:65535/x")).toBe(true);
  });

  it("refuse http, autres schémas, identifiants intégrés, espaces, caractères dangereux", () => {
    for (const bad of [
      "http://exemple.test",
      "javascript:alert(1)",
      "data:text/html,x",
      "//exemple.test",
      "https://user:pass@exemple.test",
      "https://exemple.test/a b",
      "https://exemple.test/<script>",
      'https://exemple.test/"x',
      "https://exemple.test/a\\b",
      "https://exemple.test/\u0001",
      "https://-exemple.test",
      "https://127.0.0.1/",
      "https://localhost/",
      "https://2130706433/",
      "https://0x7f.1/",
      "https://169.254.169.254/latest/meta-data",
      "https://exemple.test:99999/",
      "https://exemple.test:0/",
      "https://a..test/",
      "https://serveur.internal/x",
      "https://nas.local",
      "https://exemple.test/‮x",
      "https://exemple.test/​x",
      "https://exemple.test/\u0085x",
      "https://",
      "",
    ]) {
      expect(isSafeHttpsUrl(bad), bad).toBe(false);
    }
    expect(isSafeHttpsUrl(`https://exemple.test/${"a".repeat(2048)}`)).toBe(false);
  });
});

describe("réglages par type", () => {
  it("les 4 types de la spec existent", () => {
    expect([...PROJECT_TYPES]).toEqual(["website_sales", "salla_app", "salla_theme", "custom"]);
  });

  it("website_sales : offres, modèles, marché, questions, pages d'atterrissage", () => {
    const ok = parseProjectSettings("website_sales", {
      offers: ["Pack vitrine", "Pack boutique"],
      business_models: ["abonnement"],
      target_market: "PME marocaines",
      qualification_questions: ["Quel budget ?"],
      landing_pages: [{ name: "Accueil", url: "https://exemple.test/lp" }],
    });
    expect(ok.success).toBe(true);
    expect(parseProjectSettings("website_sales", { landing_pages: [{ name: "x", url: "http://exemple.test" }] }).success).toBe(false);
  });

  it("salla_app : nom, problème, segments, lien du store, activation, prix, FAQ", () => {
    const ok = parseProjectSettings("salla_app", {
      app_name: "Relance panier",
      problem_solved: "Réduire les paniers abandonnés",
      merchant_segments: ["mode"],
      store_url: "https://salla.sa/app/relance",
      activation_flow: "Installer puis activer",
      test_pricing: "7 jours gratuits",
      faqs: [{ question: "Combien ça coûte ?", answer: "Voir les prix." }],
    });
    expect(ok.success).toBe(true);
    expect(parseProjectSettings("salla_app", { faqs: Array.from({ length: 31 }, () => ({ question: "q", answer: "a" })) }).success).toBe(false);
  });

  it("salla_theme : aperçu, secteurs, avantages, scénarios ; les captures viennent au J17", () => {
    expect(parseProjectSettings("salla_theme", { preview_url: "https://exemple.test/theme", sectors: ["mode"], features: ["rapide"], ad_scenarios: ["lancement"] }).success).toBe(true);
    expect(parseProjectSettings("salla_theme", { screenshots: ["x.png"] }).success).toBe(false);
  });

  it("custom : notes et champs nommés bornés", () => {
    expect(parseProjectSettings("custom", { notes: "libre", fields: { budget: "5 000", canal_prefere: "email" } }).success).toBe(true);
    expect(parseProjectSettings("custom", { fields: { "Clé invalide": "x" } }).success).toBe(false);
    expect(parseProjectSettings("custom", { fields: { "1cle": "x" } }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"]));
    expect(parseProjectSettings("custom", { fields: many }).success).toBe(false);
  });

  it("clé inconnue refusée pour chaque type ; absence de réglages = objet vide", () => {
    for (const type of PROJECT_TYPES) {
      expect(parseProjectSettings(type, { inconnue: 1 }).success, type).toBe(false);
      expect(parseProjectSettings(type, undefined).success, type).toBe(true);
    }
  });

  it("un réglage d'un autre type est refusé (offers n'existe pas pour salla_app)", () => {
    expect(parseProjectSettings("salla_app", { offers: ["x"] }).success).toBe(false);
  });

  it("les textes sont rognés et le texte dangereux refusé", () => {
    const parsed = parseProjectSettings("custom", { notes: "  note  " });
    expect(parsed.success && parsed.data).toEqual({ notes: "note" });
    expect(parseProjectSettings("custom", { notes: "a‮b" }).success).toBe(false);
  });
});

describe("création et modification de projet", () => {
  it("le type choisit le schéma des réglages et les réglages ont une valeur par défaut", () => {
    const parsed = createProjectSchema.safeParse({ type: "website_sales", name: "  Site Alpha  " });
    expect(parsed.success && parsed.data).toEqual({ type: "website_sales", name: "Site Alpha", settings: {} });
    expect(createProjectSchema.safeParse({ type: "salla_app", name: "App", settings: { app_name: "A" } }).success).toBe(true);
    expect(createProjectSchema.safeParse({ type: "salla_app", name: "App", settings: { offers: ["x"] } }).success).toBe(false);
  });

  it("type inconnu, nom invalide, champ inconnu, owner_id non uuid : refusés", () => {
    expect(createProjectSchema.safeParse({ type: "autre", name: "x" }).success).toBe(false);
    expect(createProjectSchema.safeParse({ type: "custom", name: "" }).success).toBe(false);
    expect(createProjectSchema.safeParse({ type: "custom", name: "x".repeat(121) }).success).toBe(false);
    expect(createProjectSchema.safeParse({ type: "custom", name: "x", status: "archived" }).success).toBe(false);
    expect(createProjectSchema.safeParse({ type: "custom", name: "x", owner_id: "pas-un-uuid" }).success).toBe(false);
    expect(createProjectSchema.safeParse({ type: "custom", name: "x", owner_id: null }).success).toBe(true);
  });

  it("organization_id réclamé : accepté comme uuid (comparé au contexte ailleurs), jamais un autre type", () => {
    expect(createProjectSchema.safeParse({ type: "custom", name: "x", organization_id: ORG }).success).toBe(true);
    expect(createProjectSchema.safeParse({ type: "custom", name: "x", organization_id: 42 }).success).toBe(false);
  });

  it("modification : pas de type, nom et identifiant requis", () => {
    expect(updateProjectSchema.safeParse({ project_id: PROJECT, name: "Nouveau nom", settings: { notes: "x" } }).success).toBe(true);
    expect(updateProjectSchema.safeParse({ project_id: PROJECT, name: "Nom", type: "custom" }).success).toBe(false);
    expect(updateProjectSchema.safeParse({ name: "Nom" }).success).toBe(false);
  });

  it("archivage : statut connu seulement", () => {
    expect(setProjectStatusSchema.safeParse({ project_id: PROJECT, status: "archived" }).success).toBe(true);
    expect(setProjectStatusSchema.safeParse({ project_id: PROJECT, status: "deleted" }).success).toBe(false);
  });
});

describe("produits", () => {
  const base = { project_id: PROJECT, kind: "pack", offer: "Pack e-commerce\nlivraison incluse" };

  it("crée avec les seuls champs requis ; assets vide par défaut", () => {
    const parsed = createProductSchema.safeParse(base);
    expect(parsed.success && parsed.data.assets).toEqual([]);
  });

  it("URL https seulement, prix indicatif court, offre multiligne", () => {
    expect(createProductSchema.safeParse({ ...base, landing_url: "https://exemple.test/offre", price_hint: "dès 99 MAD" }).success).toBe(true);
    expect(createProductSchema.safeParse({ ...base, landing_url: "http://exemple.test" }).success).toBe(false);
    expect(createProductSchema.safeParse({ ...base, price_hint: "x".repeat(101) }).success).toBe(false);
    expect(createProductSchema.safeParse({ ...base, kind: "" }).success).toBe(false);
    expect(createProductSchema.safeParse({ ...base, kind: "a\nb" }).success).toBe(false);
  });

  it("assets : chemin {organisation}/{projet}/{fichier}, sans « .. » ni « // », 50 au plus", () => {
    const good = `${ORG}/${PROJECT}/img/logo.png`;
    expect(assetPathSchema.safeParse(good).success).toBe(true);
    expect(assetPathSchema.safeParse(`${ORG}/${PROJECT}/../x.png`).success).toBe(false);
    expect(assetPathSchema.safeParse(`${ORG}/${PROJECT}//x.png`).success).toBe(false);
    expect(assetPathSchema.safeParse("logo.png").success).toBe(false);
    expect(assetPathSchema.safeParse(`${ORG}/${PROJECT}/`).success).toBe(false);
    expect(createProductSchema.safeParse({ ...base, assets: Array.from({ length: 51 }, () => good) }).success).toBe(false);
  });

  it("modification : identifiant du produit requis, projet non modifiable", () => {
    expect(updateProductSchema.safeParse({ product_id: OTHER, kind: "k", offer: "o" }).success).toBe(true);
    expect(updateProductSchema.safeParse({ product_id: OTHER, project_id: PROJECT, kind: "k", offer: "o" }).success).toBe(false);
  });
});

describe("lignes renvoyées par la base", () => {
  const now = "2026-11-18T10:00:00+00:00";
  it("projet et produit lisibles ; ligne illisible refusée", () => {
    expect(
      projectRowSchema.safeParse({ id: PROJECT, organization_id: ORG, type: "custom", name: "n", status: "active", owner_id: null, settings: {}, created_at: now, updated_at: now }).success,
    ).toBe(true);
    expect(projectRowSchema.safeParse({ id: PROJECT, organization_id: ORG, type: "inconnu", name: "n", status: "active", owner_id: null, settings: {}, created_at: now, updated_at: now }).success).toBe(false);
    expect(
      productRowSchema.safeParse({ id: OTHER, organization_id: ORG, project_id: PROJECT, kind: "k", offer: "o", price_hint: null, landing_url: null, assets: [], created_at: now, updated_at: now }).success,
    ).toBe(true);
  });
});
