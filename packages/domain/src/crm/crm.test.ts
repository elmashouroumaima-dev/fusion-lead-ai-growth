import { describe, expect, it } from "vitest";
import {
  activeFilterNames,
  buildLeadsExportCsv,
  hasInvalidLeadListParams,
  cleanSearchQuery,
  csvCell,
  leadListQuery,
  leadListRowSchema,
  neutralizeFormula,
  parseLeadListParams,
  type LeadListRow,
} from "./index";

const UUID = "7d000000-0000-4000-8000-000000000001";

describe("parseLeadListParams", () => {
  it("valeurs par défaut : aucun filtre, tri du plus récent, page 1", () => {
    expect(parseLeadListParams({})).toEqual({
      filters: { project: null, stage: null, source: null, assignee: null, unassigned: false, query: null, sort: "created_desc" },
      page: 1,
    });
  });

  it("filtres valides lus depuis un objet ou une URL ; valeur invalide ignorée (jamais transmise)", () => {
    const parsed = parseLeadListParams(new URLSearchParams(`project=${UUID}&stage=pas-un-uuid&source=csv_import&assignee=${UUID}&unassigned=1&q=%20Nadia%20&sort=name_asc&page=3`));
    expect(parsed).toEqual({
      filters: { project: UUID, stage: null, source: "csv_import", assignee: UUID, unassigned: true, query: "Nadia", sort: "name_asc" },
      page: 3,
    });
    expect(parseLeadListParams({ source: "Web Form; drop", sort: "password", unassigned: "oui", page: "-4" })).toMatchObject({
      filters: { source: null, sort: "created_desc", unassigned: false },
      page: 1,
    });
    expect(parseLeadListParams({ page: "abc" }).page).toBe(1);
    expect(parseLeadListParams({ page: "99999999" }).page).toBe(4000);
  });

  it("un paramètre répété : le premier seulement", () => {
    expect(parseLeadListParams({ q: ["a", "b"] }).filters.query).toBe("a");
  });

  it("recherche : contrôles et caractères de direction retirés, 100 caractères au plus", () => {
    expect(cleanSearchQuery("  a\u0000b‮c  ")).toBe("a b c");
    expect(cleanSearchQuery("   ")).toBeNull();
    expect(cleanSearchQuery("x".repeat(300))).toHaveLength(100);
    expect(cleanSearchQuery(null)).toBeNull();
  });
});

describe("leadListQuery et activeFilterNames", () => {
  it("valeurs par défaut omises ; reconstruit les mêmes filtres", () => {
    const params = parseLeadListParams({ project: UUID, unassigned: "1", q: "Nadia", sort: "created_asc", page: "2" });
    const query = leadListQuery(params.filters, params.page);
    expect(query).toBe(`project=${UUID}&unassigned=1&q=Nadia&sort=created_asc&page=2`);
    expect(parseLeadListParams(new URLSearchParams(query))).toEqual(params);
    expect(leadListQuery(parseLeadListParams({}).filters)).toBe("");
  });

  it("l'audit ne retient que les NOMS des filtres actifs", () => {
    const names = activeFilterNames(parseLeadListParams({ q: "nadia@exemple.ma", project: UUID }).filters);
    expect(names).toEqual({ project: true, query: true });
    expect(JSON.stringify(names)).not.toContain("nadia");
  });
});

describe("hasInvalidLeadListParams : l'export refuse un filtre présent mais invalide", () => {
  it("valeurs valides, absentes ou vides : acceptées", () => {
    expect(hasInvalidLeadListParams({})).toBe(false);
    expect(hasInvalidLeadListParams({ project: "", stage: "", source: "", sort: "" })).toBe(false);
    expect(hasInvalidLeadListParams({ project: UUID, source: "csv_import", sort: "name_asc", unassigned: "1", q: "a" })).toBe(false);
  });

  it("UUID mal formé, source ou tri inconnus, « non assignés » autre que 1 : refusés", () => {
    expect(hasInvalidLeadListParams({ project: "pas-un-uuid" })).toBe(true);
    expect(hasInvalidLeadListParams({ assignee: "1" })).toBe(true);
    expect(hasInvalidLeadListParams({ source: "Web Form" })).toBe(true);
    expect(hasInvalidLeadListParams({ sort: "password" })).toBe(true);
    expect(hasInvalidLeadListParams({ unassigned: "oui" })).toBe(true);
    expect(hasInvalidLeadListParams(new URLSearchParams("stage=zzz"))).toBe(true);
  });
});

describe("export CSV : injection de formule", () => {
  it("préfixe d'une apostrophe les cellules qui commencent par = + - @ tabulation ou retour chariot", () => {
    for (const value of ["=1+1", "+cmd|' /C calc'!A0", "-2+3", "@SUM(A1)", "\tx", "\rx", "=HYPERLINK(\"http://x\")"]) {
      expect(neutralizeFormula(value), value).toBe(`'${value}`);
    }
    for (const value of ["Nadia", "a=b", "1+1", "nadia@exemple.ma", ""]) expect(neutralizeFormula(value), value).toBe(value);
  });

  it("formule précédée d'espaces ou de caractères invisibles : neutralisée aussi", () => {
    for (const value of [" =1+1", "  +cmd", "\u00a0@x", "\u200b=1", "\ufeff-2", "\n=1"]) {
      expect(neutralizeFormula(value), JSON.stringify(value)).toBe(`'${value}`);
    }
    expect(neutralizeFormula("a =1")).toBe("a =1");
  });

  it("un numéro E.164 reste intact ; un « + » suivi d'autre chose est neutralisé", () => {
    expect(neutralizeFormula("+212612345678")).toBe("+212612345678");
    expect(neutralizeFormula("+212612345678a")).toBe("'+212612345678a");
    expect(neutralizeFormula("+21")).toBe("'+21");
  });

  it("guillemets, virgules et retours à la ligne ; neutralisation AVANT la mise entre guillemets", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("l1\nl2")).toBe('"l1\nl2"');
    expect(csvCell("=A1,B1")).toBe(`"'=A1,B1"`);
    expect(csvCell(null)).toBe("");
    expect(csvCell(7)).toBe("7");
  });

  const row = (over: Partial<LeadListRow> = {}): LeadListRow => ({
    id: UUID, contact_id: UUID, project_id: UUID, source: "web_form", stage_id: UUID, stage_name: "Nouveau", stage_kind: "open", assignee_id: null,
    score: null, created_at: "2026-11-26T10:00:00+00:00", updated_at: "2026-11-26T10:00:00+00:00", contact_name: "Nadia", contact_email: "n@x.ma",
    contact_phone: "+212612345678", total_count: 1, ...over,
  });

  it("fichier : BOM, en-tête, CRLF, noms arabes conservés, formules neutralisées dans le nom et l'e-mail", () => {
    const csv = buildLeadsExportCsv([row({ contact_name: "سارة المنصوري" }), row({ contact_name: "=cmd|calc", contact_email: "@x" })]);
    expect(csv.startsWith("\uFEFFsep=,\r\nlead_id,created_at,name,email,phone,source,stage,assignee_id,project_id\r\n")).toBe(true);
    const lines = csv.slice(1).trim().split("\r\n");
    expect(lines[0]).toBe("sep=,");
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain("سارة المنصوري");
    expect(lines[3]).toContain("'=cmd|calc");
    expect(lines[3]).toContain("'@x");
    expect(lines[2]).toContain("+212612345678");
  });

  it("aucun lead : seulement l'en-tête", () => {
    expect(buildLeadsExportCsv([])).toBe("\uFEFFsep=,\r\nlead_id,created_at,name,email,phone,source,stage,assignee_id,project_id\r\n");
  });
});

describe("leadListRowSchema", () => {
  it("le total arrive en nombre ou en texte (bigint) et devient un nombre", () => {
    const base = {
      id: UUID, contact_id: UUID, project_id: UUID, source: "web_form", stage_id: UUID, stage_name: "N", stage_kind: "open", assignee_id: null, score: null,
      created_at: "x", updated_at: "x", contact_name: null, contact_email: null, contact_phone: null,
    };
    expect(leadListRowSchema.parse({ ...base, total_count: "42" }).total_count).toBe(42);
    expect(leadListRowSchema.parse({ ...base, total_count: 7 }).total_count).toBe(7);
    expect(leadListRowSchema.safeParse({ ...base, total_count: 1, stage_kind: "autre" }).success).toBe(false);
  });
});
