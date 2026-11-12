import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ar from "./ar.json";
import en from "./en.json";
import fr from "./fr.json";

const WEB_ROOT = path.resolve(__dirname, "..");
const SOURCES = ["app/[locale]/(app)/crm/page.tsx", "components/crm-sync/retry-button.tsx"];
const catalogs = { fr: fr.CrmSync, en: en.CrmSync, ar: ar.CrmSync } as const;
const lookup = (root: unknown, dotted: string): unknown =>
  dotted.split(".").reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), root);

describe("écran de synchro CRM (J25) : messages", () => {
  it.each(SOURCES)("%s : chaque clé littérale t(\"…\") existe en fr, en et ar", (rel) => {
    const src = readFileSync(path.join(WEB_ROOT, rel), "utf8");
    for (const key of [...src.matchAll(/\bt\("([A-Za-z0-9_.]+)"/g)].map((m) => m[1] as string)) {
      for (const [locale, messages] of Object.entries(catalogs)) expect(typeof lookup(messages, key), `${rel} : ${locale} ${key}`).toBe("string");
    }
  });

  it("clés dynamiques : fournisseurs, états, erreurs, champs, sources de vérité, sens", () => {
    for (const messages of Object.values(catalogs)) {
      for (const k of ["csv", "internal"]) expect(typeof lookup(messages, `providers.${k}`)).toBe("string");
      for (const k of ["never", "queued", "running", "ok", "failed"]) expect(typeof lookup(messages, `status.${k}`)).toBe("string");
      for (const k of ["file_missing", "file_malformed", "mapping_invalid", "failed"]) expect(typeof lookup(messages, `errors.${k}`)).toBe("string");
      for (const k of ["external_id", "external_updated_at", "email", "phone", "name", "language", "country"]) expect(typeof lookup(messages, `fields.${k}`)).toBe("string");
      for (const k of ["internal", "external"]) expect(typeof lookup(messages, `truth.${k}`)).toBe("string");
      for (const k of ["pull", "push", "both"]) expect(typeof lookup(messages, `directions.${k}`)).toBe("string");
    }
    for (const messages of [fr, en, ar]) expect(typeof messages.Shell.nav.crmSync).toBe("string");
  });

  it("aucune classe physique (gauche / droite) : CSS logique", () => {
    const PHYSICAL = /\b(?:-?m[lr]-|-?p[lr]-|left-|right-|text-left|text-right|float-left|float-right)/;
    for (const rel of SOURCES) {
      const src = readFileSync(path.join(WEB_ROOT, rel), "utf8");
      const classes = [...src.matchAll(/class(?:Name)?="([^"]*)"/g)].flatMap((m) => (m[1] as string).split(/\s+/));
      expect(classes.filter((cls) => PHYSICAL.test(cls.replace(/^[a-z-]+:/, ""))), rel).toEqual([]);
    }
  });
});
