import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Confinement de service_role (J11, invariant 7) : en plus de la règle ESLint no-restricted-imports,
 * ce test échoue si un fichier de apps/web hors `lib/service/**` (hors tests) importe le client admin
 * ou mentionne la clé secrète, ou si un composant client touche à la couche service.
 */
const WEB_ROOT = path.resolve(import.meta.dirname, "../..");
const SKIP_DIRS = new Set(["node_modules", ".next"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const rel = (file: string) => path.relative(WEB_ROOT, file).split(path.sep).join("/");
const isTest = (file: string) => /\.test\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file);
const files = walk(WEB_ROOT).filter((f) => !isTest(f));
const read = (file: string) => readFileSync(file, "utf8");

/**
 * Toute référence au module admin : import statique / export-from, import() dynamique, require(), avec ou
 * sans suffixe (`.ts`, `.js`, `.mjs`...) et variante de dossier (`admin/index`). `admin-panel` n'en est pas une.
 */
const ADMIN_REFERENCE =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["'][^"']*supabase\/admin(?:\.[a-z]+)?(?:\/index(?:\.[a-z]+)?)?["']/;
const SUPABASE_JS_REFERENCE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["']@supabase\/supabase-js(?:\/[^"']*)?["']/;

describe("confinement du client service_role", () => {
  it("le module admin existe et commence par server-only", () => {
    expect(read(path.join(WEB_ROOT, "lib/supabase/admin.ts"))).toMatch(/^import "server-only";/m);
  });

  it("aucun fichier hors lib/service/** n'importe lib/supabase/admin", () => {
    const offenders = files
      .filter((f) => rel(f) !== "lib/supabase/admin.ts")
      .filter((f) => !rel(f).startsWith("lib/service/"))
      .filter((f) => ADMIN_REFERENCE.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("l'expression de détection voit les suffixes .js / .mjs, les variantes index, import() et require()", () => {
    for (const code of [
      'import { a } from "../supabase/admin";',
      'import { a } from "../supabase/admin.ts";',
      'import { a } from "../supabase/admin.js";',
      'import { a } from "@/lib/supabase/admin.mjs";',
      'import { a } from "../supabase/admin/index";',
      'export * from "../supabase/admin/index.ts";',
      'const m = await import("../supabase/admin.js");',
      'const m = require("../supabase/admin");',
      'import "../supabase/admin";',
    ]) {
      expect(ADMIN_REFERENCE.test(code), code).toBe(true);
    }
    for (const code of ['import { a } from "./admin-panel";', 'import { a } from "../supabase/server";', 'import { a } from "../supabase/administrator";']) {
      expect(ADMIN_REFERENCE.test(code), code).toBe(false);
    }
  });

  it("seul admin.ts importe @supabase/supabase-js (les clients @supabase/ssr restent libres)", () => {
    const offenders = files.filter((f) => SUPABASE_JS_REFERENCE.test(read(f))).map(rel);
    expect(offenders).toEqual(["lib/supabase/admin.ts"]);
    expect(SUPABASE_JS_REFERENCE.test('import { x } from "@supabase/ssr";')).toBe(false);
    expect(SUPABASE_JS_REFERENCE.test('const x = await import("@supabase/supabase-js");')).toBe(true);
  });

  it("seul admin.ts (et lib/env/**) mentionne SUPABASE_SECRET_KEY dans apps/web", () => {
    const offenders = files
      .filter((f) => !rel(f).startsWith("lib/env/"))
      .filter((f) => read(f).includes("SUPABASE_SECRET_KEY"))
      .map(rel);
    expect(offenders).toEqual(["lib/supabase/admin.ts"]);
  });

  it("aucun composant client n'importe la couche service ni le client admin", () => {
    const offenders = files
      .filter((f) => /^\s*["']use client["']/.test(read(f)))
      .filter((f) => /from\s+["'][^"']*(\/service\/|supabase\/admin)/.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("aucun fichier hors test n'importe un fichier *.test.* (statique, import(), require())", () => {
    const TEST_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["'][^"']*\.test(?:\.[a-z]+)?["']/;
    expect(files.filter((f) => TEST_IMPORT.test(read(f))).map(rel)).toEqual([]);
    expect(TEST_IMPORT.test('import { a } from "./x.test";')).toBe(true);
    expect(TEST_IMPORT.test('const m = await import("../x.test.ts");')).toBe(true);
    expect(TEST_IMPORT.test('import { a } from "./contest";')).toBe(false);
  });

  it("aucun import() / require() à chemin calculé dans le code hors test de apps/web", () => {
    const COMPUTED = /(?:\bimport|\brequire)\s*\(\s*(?!["'][^"'`]*["']\s*\))/;
    expect(files.filter((f) => COMPUTED.test(read(f))).map(rel)).toEqual([]);
    for (const code of ["import(`./${x}`)", "require(p)", 'import("a" + b)', "import(`../supabase/admin`)"]) {
      expect(COMPUTED.test(code), code).toBe(true);
    }
    for (const code of ['import("./a")', "require('x')"]) expect(COMPUTED.test(code), code).toBe(false);
  });

  it("aucune variable NEXT_PUBLIC_ ne porte un nom de secret", () => {
    const offenders = files.filter((f) => /NEXT_PUBLIC_[A-Z_]*SECRET/.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });
});
