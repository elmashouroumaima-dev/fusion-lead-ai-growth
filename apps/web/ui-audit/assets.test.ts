import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Actifs de l'interface : polices locales (next/font/local, licence OFL) et CSS mort (ADR 015 : on supprime
 * les modules CSS et le CSS global hérité dès qu'ils ne servent plus).
 */
const WEB_ROOT = path.resolve(__dirname, "..");
const read = (rel: string): string => readFileSync(path.join(WEB_ROOT, rel), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
const rel = (file: string): string => path.relative(WEB_ROOT, file).split(path.sep).join("/");
const ALL = walk(WEB_ROOT).map(rel);
const isTest = (f: string): boolean => /\.test\.(?:ts|tsx)$/.test(f);
const SOURCES = ALL.filter((f) => /\.(?:ts|tsx)$/.test(f) && !isTest(f) && !f.endsWith(".d.ts"));

// --------------------------------------------------------------------------------------------------
// Polices
// --------------------------------------------------------------------------------------------------

describe("polices locales (next/font/local)", () => {
  const fontsSource = read("app/fonts/fonts.ts");
  const cairoSource = read("app/fonts/cairo.ts");
  const referenced = [...fontsSource.matchAll(/path:\s*"\.\/([^"]+)"/g), ...cairoSource.matchAll(/path:\s*"\.\/([^"]+)"/g)].map((m) => m[1] as string);

  it("fonts.ts et cairo.ts référencent des fichiers et uniquement next/font/local (aucun réseau)", () => {
    expect(referenced.length).toBeGreaterThanOrEqual(5);
    expect(fontsSource).toContain('from "next/font/local"');
    expect(cairoSource).toContain('from "next/font/local"');
    expect(fontsSource).not.toMatch(/next\/font\/google/);
    for (const f of SOURCES) {
      const src = read(f);
      expect(src, f).not.toMatch(/next\/font\/google|fonts\.googleapis\.com|fonts\.gstatic\.com/);
    }
    for (const f of ALL.filter((x) => x.endsWith(".css"))) {
      expect(read(f), f).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com|@import\s+url\(["']?https?:/);
    }
  });

  it.each(["Poppins-Regular.woff2", "Poppins-Medium.woff2", "Poppins-SemiBold.woff2", "Poppins-Bold.woff2", "Cairo-Variable.woff2"])(
    "%s est référencé par fonts.ts ou cairo.ts",
    (name) => {
      expect(referenced).toContain(name);
    },
  );

  it.each(referenced)("%s existe, est un WOFF2 sous-ensemblé (léger) et non une TTF complète", (name) => {
    const file = path.join(WEB_ROOT, "app/fonts", name);
    expect(existsSync(file), `${name} introuvable`).toBe(true);
    const bytes = readFileSync(file);
    expect(name.endsWith(".woff2"), name).toBe(true);
    expect(bytes.subarray(0, 4).toString("latin1"), `${name} : signature WOFF2`).toBe("wOF2");
    expect(bytes.length).toBeGreaterThan(2_000);
    // Sous-ensemble : Poppins complet pèse ~160 Ko par graisse, Cairo complet ~600 Ko.
    expect(bytes.length, `${name} n'est pas sous-ensemblé`).toBeLessThan(name.startsWith("Cairo") ? 150_000 : 30_000);
  });

  it("aucun fichier de police orphelin dans app/fonts", () => {
    const onDisk = readdirSync(path.join(WEB_ROOT, "app/fonts")).filter((f) => /\.(?:ttf|otf|woff2?)$/.test(f));
    expect(onDisk.sort()).toEqual([...referenced].sort());
  });

  it.each([
    ["OFL-Poppins.txt", "Poppins"],
    ["OFL-Cairo.txt", "Cairo"],
  ])("la licence %s est présente et est bien la SIL Open Font License 1.1 (%s)", (file, family) => {
    const full = path.join(WEB_ROOT, "app/fonts", file);
    expect(existsSync(full), `${file} manquant`).toBe(true);
    const text = readFileSync(full, "utf8");
    expect(text).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/i);
    expect(text).toMatch(/PERMISSION & CONDITIONS/);
    expect(text).toContain(family);
  });

  it("les deux familles sont branchées : variables CSS, --font-app, classe de <html>", () => {
    expect(fontsSource).toContain('variable: "--font-poppins"');
    expect(cairoSource).toContain('variable: "--font-cairo"');
    const css = read("app/globals.css");
    // fr / en : Poppins seul (Cairo n'y est pas chargé) ; ar : Cairo d'abord, Poppins ensuite
    expect(css).toMatch(/--font-app:\s*var\(--font-poppins\),\s*system-ui/);
    expect(css).toMatch(/:root:lang\(ar\)\s*\{[^}]*--font-app:[^;]*var\(--font-cairo\)[^;]*var\(--font-poppins\)/);
    expect(css).toMatch(/:root:lang\(ar\)\s*\{[^}]*--font-app:\s*var\(--font-cairo\)/);
    expect(css).toMatch(/--font-sans:\s*var\(--font-app\)/);
    const layout = read("app/[locale]/layout.tsx");
    expect(layout).toContain("poppins.variable");
    expect(layout).toContain("cairo.variable");
  });

  it("Cairo n'est chargé que pour la locale arabe : import dynamique conditionnel, jamais préchargé sur fr / en", () => {
    const layout = read("app/[locale]/layout.tsx");
    expect(layout, "import statique de Cairo interdit").not.toMatch(/import\s[^;]*from\s+"[^"]*fonts\/cairo"/);
    expect(layout).not.toMatch(/import\s*\{[^}]*\bcairo\b[^}]*\}\s*from\s+"[^"]*fonts\/fonts"/);
    expect(layout).toMatch(/locale === "ar"\s*\?\s*\(await import\("\.\.\/fonts\/cairo"\)\)/);
    expect(fontsSource, "fonts.ts ne doit pas déclarer Cairo").not.toContain("Cairo-");
    // preload: true ajouterait un <link rel="preload"> de Cairo à toutes les pages (fr / en compris)
    expect(cairoSource).toMatch(/preload:\s*false/);
  });
});

// --------------------------------------------------------------------------------------------------
// CSS mort
// --------------------------------------------------------------------------------------------------

describe("CSS mort", () => {
  const cssFiles = ALL.filter((f) => f.endsWith(".css") && !f.startsWith("app/fonts/"));
  const moduleCss = cssFiles.filter((f) => f.endsWith(".module.css"));
  const importedBy = (cssFile: string): string[] => {
    const base = path.posix.basename(cssFile);
    const importers: string[] = [];
    for (const f of [...SOURCES, ...cssFiles]) {
      if (f === cssFile) continue;
      const src = read(f);
      const re = new RegExp(String.raw`(?:from\s+|import\s+|@import\s+)["']([^"']*${base.replace(/[.]/g, "\\.")})["']`);
      if (re.test(src)) importers.push(f);
    }
    return importers;
  };

  it("il existe au moins la feuille globale (la détection n'est pas vide)", () => {
    expect(cssFiles).toContain("app/globals.css");
  });

  for (const file of cssFiles) {
    it(`${file} est importe quelque part (fichier non orphelin)`, () => {
      expect(importedBy(file), `${file} n'est importe par rien : a supprimer`).not.toEqual([]);
    });
  }

  it("la feuille globale est importée par le layout racine", () => {
    expect(read("app/[locale]/layout.tsx")).toMatch(/import\s+"\.\.\/globals\.css"/);
  });

  for (const file of moduleCss) {
  it(`${file} : chaque classe définie est utilisée`, () => {
    const css = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
    const defined = new Set([...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1] as string));
    const importers = importedBy(file);
    const base = path.posix.basename(file).replace(/[.]/g, "\\.");
    const used = new Set<string>();
    for (const importer of importers) {
      const src = read(importer);
      const binding = new RegExp(String.raw`import\s+(\w+)\s+from\s+["'][^"']*${base}["']`).exec(src)?.[1];
      if (!binding) continue;
      for (const m of src.matchAll(new RegExp(String.raw`\b${binding}\.(\w+)|\b${binding}\[["']([\w-]+)["']\]`, "g"))) used.add((m[1] ?? m[2]) as string);
    }
    const dead = [...defined].filter((c) => !used.has(c));
    expect(dead, `classes mortes dans ${file}`).toEqual([]);
  });
  }

  const legacyFile = "app/legacy.css";
  const legacyExists = existsSync(path.join(WEB_ROOT, legacyFile));

  it("la feuille héritée legacy.css est supprimée et n'est plus importée", () => {
    expect(legacyExists).toBe(false);
    expect(/@import\s+"\.\/legacy\.css"/.test(read("app/globals.css"))).toBe(false);
  });

  it("alias hérités de globals.css : chacun est encore référencé ailleurs (sinon à supprimer)", () => {
    const css = read("app/globals.css");
    const aliasBlock = /\/\* Alias hérités[^*]*\*\/([\s\S]*?)(?=\n\}\n)/.exec(css)?.[1] ?? "";
    const aliases = [...aliasBlock.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1] as string);
    if (aliases.length === 0) return; // tous retirés : cas souhaité
    const corpus = [...cssFiles.filter((f) => f !== "app/globals.css"), ...SOURCES].map(read).join("\n");
    const dead = aliases.filter((a) => !new RegExp(String.raw`var\(\s*${a}\b`).test(corpus));
    expect(dead, "alias hérités sans consommateur").toEqual([]);
  });
});

// --------------------------------------------------------------------------------------------------
// Composants orphelins (code mort)
// --------------------------------------------------------------------------------------------------

describe("composants applicatifs orphelins", () => {
  const candidates = SOURCES.filter((f) => f.startsWith("components/") && !f.startsWith("components/ui/") && f.endsWith(".tsx"));
  const importers = (file: string): string[] => {
    const base = path.posix.basename(file).replace(/\.tsx$/, "");
    const re = new RegExp(String.raw`from\s+["'][^"']*/${base.replace(/[.]/g, "\\.")}["']`);
    return [...SOURCES, ...ALL.filter(isTest)].filter((f) => f !== file && re.test(read(f)));
  };

  it("la détection voit des composants importés (pas de faux vert)", () => {
    expect(candidates.length).toBeGreaterThan(20);
    expect(importers("components/auth/auth-form.tsx").length).toBeGreaterThan(0);
  });

  for (const file of candidates) {
    it(`${file} est importé par une page ou un composant`, () => {
      const nonTest = importers(file).filter((f) => !isTest(f));
      expect(nonTest, `${file} n'est importé par aucun code de production : à supprimer`).not.toEqual([]);
    });
  }
});
