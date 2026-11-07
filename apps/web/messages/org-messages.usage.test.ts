import { readFileSync } from "node:fs";
import path from "node:path";
import { APP_ROLES } from "@fusion-leap/domain";
import { describe, expect, it } from "vitest";
import ar from "./ar.json";
import en from "./en.json";
import fr from "./fr.json";

const WEB_ROOT = path.resolve(__dirname, "..");
const SOURCES = [
  "components/org/create-organization-form.tsx",
  "components/org/organization-list.tsx",
  "components/org/organization-switcher.tsx",
  "app/[locale]/(app)/onboarding/page.tsx",
  "app/[locale]/(app)/select-organization/page.tsx",
  "app/[locale]/(app)/dashboard/page.tsx",
];

type Json = string | { [k: string]: Json };

function leafPaths(obj: Json, prefix = ""): string[] {
  if (typeof obj === "string") return [prefix];
  return Object.entries(obj).flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k));
}
function lookup(root: Json, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), root);
}
function read(rel: string): string {
  return readFileSync(path.join(WEB_ROOT, rel), "utf8");
}

describe("Org.* : parité ar / en", () => {
  it("mêmes clés exactes dans les deux langues", () => {
    expect(leafPaths(ar.Org as Json).sort()).toEqual(leafPaths(en.Org as Json).sort());
    expect(leafPaths(fr.Org as Json).sort()).toEqual(leafPaths(en.Org as Json).sort());
  });

  it("aucune valeur vide, et l'arabe contient bien de l'arabe", () => {
    for (const p of leafPaths(ar.Org as Json)) {
      const a = lookup(ar.Org as Json, p) as string;
      const e = lookup(en.Org as Json, p) as string;
      expect(a.trim(), `ar ${p}`).not.toBe("");
      expect(e.trim(), `en ${p}`).not.toBe("");
      expect(a, `ar ${p} doit être traduit`).toMatch(/[؀-ۿ]/);
    }
  });

  it("un libellé de rôle par rôle applicatif, dans les deux langues, sans clé en trop", () => {
    for (const org of [ar.Org, en.Org, fr.Org]) {
      expect(Object.keys(org.roles).sort()).toEqual([...APP_ROLES].sort());
    }
  });

  it("un message pour chaque code d'erreur d'action (types.ts), sans clé en trop", () => {
    const codes = ["duplicate_request", "forbidden", "generic", "idempotency_conflict", "idempotency_in_progress", "invalid_input", "rate_limited", "service_unavailable"];
    for (const org of [ar.Org, en.Org, fr.Org]) expect(Object.keys(org.errors).sort()).toEqual(codes);
  });

  it("types.ts et ce test listent les mêmes codes d'erreur", () => {
    const src = read("lib/tenant/types.ts");
    const declared = [...src.matchAll(/\|\s*"([a-z_]+)"/g)].map((m) => m[1]).filter((c) => c !== "idle" && c !== "success" && c !== "error");
    expect(declared.sort()).toEqual([
      "duplicate_request",
      "forbidden",
      "generic",
      "idempotency_conflict",
      "idempotency_in_progress",
      "invalid_input",
      "rate_limited",
      "service_unavailable",
    ]);
  });
});

describe("Org.* : toutes les clés utilisées par les composants existent", () => {
  // Variable de traduction liée au namespace Org dans chaque fichier (dashboard : t = Dashboard, to = Org).
  const ORG_VAR: Record<string, string> = { "app/[locale]/(app)/dashboard/page.tsx": "to" };
  it.each(SOURCES)("%s", (rel) => {
    const v = ORG_VAR[rel] ?? "t";
    const pattern = new RegExp(String.raw`\b${v}\(\s*"([A-Za-z0-9_.]+)"`, "g");
    const used = [...read(rel).matchAll(pattern)].map((m) => m[1] as string);
    for (const key of used) {
      expect(lookup(ar.Org as Json, key), `ar Org.${key}`).toBeTypeOf("string");
      expect(lookup(en.Org as Json, key), `en Org.${key}`).toBeTypeOf("string");
      expect(lookup(fr.Org as Json, key), `fr Org.${key}`).toBeTypeOf("string");
    }
    if (!rel.includes("dashboard")) expect(used.length, "au moins une clé détectée").toBeGreaterThan(0);
  });

  it("le formulaire et la liste utilisent Common.submitting, présent dans les deux langues", () => {
    expect(read("components/org/create-organization-form.tsx")).toContain('tc("submitting")');
    expect(read("components/org/organization-list.tsx")).toContain('tc("submitting")');
    expect(lookup(ar as unknown as Json, "Common.submitting")).toBeTypeOf("string");
    expect(lookup(en as unknown as Json, "Common.submitting")).toBeTypeOf("string");
    expect(lookup(fr as unknown as Json, "Common.submitting")).toBeTypeOf("string");
  });

  it("clés dynamiques : roles.<rôle> et errors.<code> couvrent toutes les valeurs possibles", () => {
    for (const role of APP_ROLES) {
      expect(lookup(ar.Org as Json, `roles.${role}`), `ar ${role}`).toBeTypeOf("string");
      expect(lookup(en.Org as Json, `roles.${role}`), `en ${role}`).toBeTypeOf("string");
      expect(lookup(fr.Org as Json, `roles.${role}`), `fr ${role}`).toBeTypeOf("string");
    }
  });
});

describe("Org : pas de texte codé en dur dans les composants", () => {
  it.each(SOURCES.filter((s) => s.endsWith(".tsx") && s.startsWith("components")))("%s", (rel) => {
    const src = read(rel);
    // Aucun nœud texte JSX contenant des lettres (hors expressions {…}) ni d'attribut aria-label littéral.
    const jsxText = [...src.matchAll(/>\s*([^<>{}\n]*[A-Za-z؀-ۿ][^<>{}\n]*)\s*</g)].map((m) => (m[1] ?? "").trim());
    expect(jsxText.filter((t) => t && !/^[=&|?:;,.()\s-]+$/.test(t) && !/=>/.test(t))).toEqual([]);
    expect(src).not.toMatch(/aria-label="[^"]+"/);
  });
});
