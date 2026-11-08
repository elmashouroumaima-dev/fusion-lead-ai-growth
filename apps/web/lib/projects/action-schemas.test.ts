import { describe, expect, it } from "vitest";
import { toActionCode } from "./action-code";
import {
  createProductFormSchema,
  jsonNestingDepth,
  createProjectFormSchema,
  PRODUCT_CREATE_FIELDS,
  PROJECT_FORM_FIELDS,
  setProjectStatusFormSchema,
  updateProductFormSchema,
  updateProjectFormSchema,
} from "./action-schemas";

const ORG = "7b000000-0000-4000-8000-00000000000a";
const PROJECT = "7c000000-0000-4000-8000-0000000000a1";
const PRODUCT = "7d000000-0000-4000-8000-0000000000a1";

describe("création de projet (champs de formulaire)", () => {
  const raw = (over: Record<string, string | undefined> = {}) => ({ type: "website_sales", name: "  Site Alpha ", settings: '{"offers":["Pack"]}', organization_id: ORG, ...over });

  it("transforme les champs en entrée métier (nom rogné, réglages décodés, organisation réclamée conservée pour comparaison)", () => {
    const parsed = createProjectFormSchema.safeParse(raw());
    expect(parsed.success && parsed.data).toEqual({ type: "website_sales", name: "Site Alpha", settings: { offers: ["Pack"] }, organization_id: ORG });
  });

  it("réglages absents -> objet vide ; organisation absente -> rien de réclamé", () => {
    const parsed = createProjectFormSchema.safeParse(raw({ settings: undefined, organization_id: "" }));
    expect(parsed.success && parsed.data).toEqual({ type: "website_sales", name: "Site Alpha", settings: {} });
  });

  it("JSON illisible REFUSÉ (jamais remplacé par un objet vide)", () => {
    expect(createProjectFormSchema.safeParse(raw({ settings: "{pas du json" })).success).toBe(false);
    expect(createProjectFormSchema.safeParse(raw({ settings: "[]" })).success).toBe(false);
    expect(createProjectFormSchema.safeParse(raw({ settings: "null" })).success).toBe(false);
  });

  it("clé __proto__ refusée (création et modification), clés ordinaires inconnues aussi", () => {
    expect(createProjectFormSchema.safeParse(raw({ settings: '{"__proto__":{"x":1},"offers":["a"]}' })).success).toBe(false);
    expect(updateProjectFormSchema.safeParse({ project_id: PROJECT, name: "n", settings: '{"__proto__":{"x":1},"offers":["a"]}' }).success).toBe(false);
    expect(updateProjectFormSchema.safeParse({ project_id: PROJECT, name: "n", settings: '{"a":{"__proto__":1}}' }).success).toBe(false);
    expect(updateProjectFormSchema.safeParse({ project_id: PROJECT, name: "n", settings: '{"evil":"x"}' }).success).toBe(true); // forme jugée par le service (type du projet)
  });

  it("JSON trop profond refusé sans récursion (5 000 niveaux : refus immédiat)", () => {
    const deep = '{"a":'.repeat(5000) + "1" + "}".repeat(5000);
    expect(createProjectFormSchema.safeParse(raw({ settings: deep })).success).toBe(false);
    expect(updateProjectFormSchema.safeParse({ project_id: PROJECT, name: "n", settings: deep }).success).toBe(false);
    expect(jsonNestingDepth('{"a":{"b":{"c":[1,{"d":2}]}}}')).toBe(5);
    expect(jsonNestingDepth('{"a":"{{{{{{{{{{"}')).toBe(1); // les accolades dans un texte ne comptent pas
    expect(jsonNestingDepth('{"a":"\\"{"}')).toBe(1);
  });

  it("type inconnu, nom vide, réglage d'un autre type, lien non https : refusés", () => {
    expect(createProjectFormSchema.safeParse(raw({ type: "autre" })).success).toBe(false);
    expect(createProjectFormSchema.safeParse(raw({ name: "   " })).success).toBe(false);
    expect(createProjectFormSchema.safeParse(raw({ type: "salla_app", settings: '{"offers":["x"]}' })).success).toBe(false);
    expect(createProjectFormSchema.safeParse(raw({ settings: '{"landing_pages":[{"name":"a","url":"http://exemple.test"}]}' })).success).toBe(false);
  });

  it("la liste de champs lus est fermée : aucun propriétaire, statut ni identifiant d'entreprise imposé par le formulaire", () => {
    expect([...PROJECT_FORM_FIELDS]).toEqual(["type", "name", "settings", "organization_id"]);
    expect([...PRODUCT_CREATE_FIELDS]).not.toContain("owner_id");
  });
});

describe("modification et statut", () => {
  it("modification : le propriétaire n'est pas lu du formulaire (conservé par le service)", () => {
    const parsed = updateProjectFormSchema.safeParse({ project_id: PROJECT, name: "Nouveau", settings: '{"notes":"n"}', owner_id: "pirate" });
    expect(parsed.success && "owner_id" in parsed.data).toBe(false);
  });

  it("statut : archived ou active seulement", () => {
    expect(setProjectStatusFormSchema.safeParse({ project_id: PROJECT, status: "archived" }).success).toBe(true);
    expect(setProjectStatusFormSchema.safeParse({ project_id: PROJECT, status: "active" }).success).toBe(true);
    expect(setProjectStatusFormSchema.safeParse({ project_id: PROJECT, status: "deleted" }).success).toBe(false);
  });
});

describe("produits (champs de formulaire)", () => {
  const raw = (over: Record<string, string | undefined> = {}) => ({ project_id: PROJECT, kind: "pack", offer: "Pack e-commerce", price_hint: "", landing_url: "", assets: undefined, ...over });

  it("champs facultatifs vides -> null ; fichiers absents -> liste vide", () => {
    const parsed = createProductFormSchema.safeParse(raw());
    expect(parsed.success && parsed.data).toEqual({ project_id: PROJECT, kind: "pack", offer: "Pack e-commerce", price_hint: null, landing_url: null, assets: [] });
  });

  it("modification : les fichiers déjà associés sont repris tels quels (chemins valides seulement)", () => {
    const asset = `${ORG}/${PROJECT}/logo.png`;
    const ok = updateProductFormSchema.safeParse({ ...raw(), project_id: undefined, product_id: PRODUCT, assets: JSON.stringify([asset]) });
    expect(ok.success && ok.data.assets).toEqual([asset]);
    expect(updateProductFormSchema.safeParse({ ...raw(), project_id: undefined, product_id: PRODUCT, assets: '["../x.png"]' }).success).toBe(false);
    expect(updateProductFormSchema.safeParse({ ...raw(), project_id: undefined, product_id: PRODUCT, assets: "pas du json" }).success).toBe(false);
  });

  it("URL http, texte avec caractère invisible ou prix trop long : refusés", () => {
    expect(createProductFormSchema.safeParse(raw({ landing_url: "http://exemple.test" })).success).toBe(false);
    expect(createProductFormSchema.safeParse(raw({ landing_url: "https://127.0.0.1/" })).success).toBe(false);
    expect(createProductFormSchema.safeParse(raw({ kind: "a؜b" })).success).toBe(false);
    expect(createProductFormSchema.safeParse(raw({ price_hint: "x".repeat(101) })).success).toBe(false);
    expect(createProductFormSchema.safeParse(raw({ landing_url: "https://exemple.test/offre" })).success).toBe(true);
  });
});

describe("codes d'erreur de formulaire", () => {
  it.each([
    ["validation_failed", "invalid_input"],
    ["payload_too_large", "invalid_input"],
    ["forbidden", "forbidden"],
    ["unauthenticated", "forbidden"],
    ["quota_exceeded", "quota_exceeded"],
    ["conflict", "conflict"],
    ["not_found", "not_found"],
    ["rate_limited", "rate_limited"],
    ["internal_error", "generic"],
  ] as const)("%s -> %s", (service, action) => {
    expect(toActionCode(service)).toBe(action);
  });
});
