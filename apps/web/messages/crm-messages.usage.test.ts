import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ar from "./ar.json";
import en from "./en.json";
import fr from "./fr.json";

const WEB_ROOT = path.resolve(__dirname, "..");
const SOURCES = [
  "components/crm/lead-filters.tsx",
  "components/crm/lead-table.tsx",
  "components/crm/deal-board.tsx",
  "app/[locale]/(app)/leads/page.tsx",
  "app/[locale]/(app)/deals/page.tsx",
];

function lookup(root: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), root);
}

const crm = { fr: fr.Crm, en: en.Crm, ar: ar.Crm } as const;

describe("écrans CRM (J24) : messages", () => {
  it.each(SOURCES)("%s : chaque clé littérale t(\"…\") existe en fr, en et ar", (rel) => {
    const src = readFileSync(path.join(WEB_ROOT, rel), "utf8");
    const keys = [...src.matchAll(/\bt\("([A-Za-z0-9_.]+)"/g)].map((m) => m[1] as string);
    for (const key of keys) {
      for (const [locale, messages] of Object.entries(crm)) {
        expect(typeof lookup(messages, key), `${rel} : ${locale} ${key}`).toBe("string");
      }
    }
  });

  it("clés dynamiques : tri, sources, types d'étape, erreurs", () => {
    for (const messages of Object.values(crm)) {
      for (const sort of ["created_desc", "created_asc", "updated_desc", "name_asc"]) expect(typeof lookup(messages, `sorts.${sort}`)).toBe("string");
      for (const source of ["web_form", "csv_import", "manual"]) expect(typeof lookup(messages, `sources.${source}`)).toBe("string");
      for (const kind of ["open", "won", "lost", "unassigned"]) expect(typeof lookup(messages, `stageKinds.${kind}`)).toBe("string");
      for (const key of ["forbidden", "notFound", "conflict", "rateLimited", "generic", "moveFailed"]) expect(typeof lookup(messages, `errors.${key}`)).toBe("string");
    }
  });

  it("navigation : « Leads » et « Deals » traduits", () => {
    for (const messages of [fr, en, ar]) {
      expect(typeof messages.Shell.nav.leads).toBe("string");
      expect(typeof messages.Shell.nav.deals).toBe("string");
    }
  });

  it("mêmes variables de message dans les trois langues", () => {
    const vars = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
    const flat = (o: unknown, prefix = ""): [string, string][] =>
      o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => flat(v, prefix ? `${prefix}.${k}` : k)) : [[prefix, String(o)]];
    const frFlat = new Map(flat(fr.Crm));
    for (const [key, text] of flat(en.Crm)) expect(vars(frFlat.get(key) ?? ""), key).toBe(vars(text));
    const arFlat = new Map(flat(ar.Crm));
    for (const [key, text] of flat(en.Crm)) expect(vars(arFlat.get(key) ?? ""), key).toBe(vars(text));
  });
});

describe("écrans CRM (J24) : CSS logique uniquement (RTL)", () => {
  const PHYSICAL = /\b(?:-?m[lr]-|-?p[lr]-|left-|right-|text-left|text-right|float-left|float-right|border-[lr]\b|border-[lr]-|rounded-[lr]-)/;
  it.each(SOURCES)("%s : aucune classe physique (gauche / droite)", (rel) => {
    const src = readFileSync(path.join(WEB_ROOT, rel), "utf8");
    const classes = [...src.matchAll(/class(?:Name)?="([^"]*)"/g)].map((m) => m[1] as string);
    const offenders = classes.flatMap((value) => value.split(/\s+/)).filter((cls) => PHYSICAL.test(cls.replace(/^[a-z-]+:/, "")));
    expect(offenders, rel).toEqual([]);
  });

  it("les flèches de pagination sont inversées en RTL", () => {
    const src = readFileSync(path.join(WEB_ROOT, "app/[locale]/(app)/leads/page.tsx"), "utf8");
    expect(src.match(/rtl:rotate-180/g)?.length).toBe(2);
  });
});
