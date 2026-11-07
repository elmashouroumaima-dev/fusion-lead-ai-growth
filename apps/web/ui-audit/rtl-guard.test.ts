import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Garde RTL (ADR 011 / 015) : AUCUNE utilité Tailwind (ni propriété CSS) physique dans apps/web/components/**
 * et apps/web/app/** (tsx, css). Les classes logiques (ms-, me-, ps-, pe-, start-, end-, text-start, rounded-s...)
 * suivent la direction du document ; les classes physiques casseraient la mise en page arabe.
 *
 * Exceptions volontaires :
 *  - `slide-in-from-left` / `slide-out-to-right` (animations Radix liées au côté : le préfixe n'est pas en début de mot) ;
 *  - toute classe précédée d'une variante `rtl:` / `ltr:` sur la même ligne pour `space-x-`, `divide-x-` et les dégradés.
 */
const WEB_ROOT = path.resolve(__dirname, "..");
const SCANNED_DIRS = ["components", "app"] as const;

/** Début de mot de classe : début de ligne, espace, guillemet, « : » (variante), « [ », « ! » ou « ( ». */
const START = String.raw`(?:^|[\s"'\x60:!\[(])`;

const PHYSICAL_TAILWIND = new RegExp(
  START +
    String.raw`-?(?:` +
    // préfixes à valeur : ml-4, pr-2, left-0, right-1/2, rounded-l-md, border-r-2, scroll-ml-2...
    String.raw`(?:ml|mr|pl|pr|left|right|scroll-ml|scroll-mr|scroll-pl|scroll-pr|rounded-[lr]|rounded-t[lr]|rounded-b[lr]|border-[lr])-` +
    "|" +
    // formes nues : text-left, float-right, rounded-l, border-r...
    String.raw`(?:float-left|float-right|text-left|text-right|rounded-l|rounded-r|border-l|border-r|clear-left|clear-right|origin-left|origin-right)(?=[\s"'\x60)\]]|$)` +
    "|" +
    // origin-top-left, etc.
    String.raw`origin-(?:top|bottom)-(?:left|right)(?=[\s"'\x60)\]]|$)` +
    ")",
);

/** `space-x-*` / `divide-x-*` n'inversent pas en RTL sans `*-reverse` ou variante `rtl:`. */
const AXIS_SPACING = new RegExp(START + String.raw`(?:space-x|divide-x)(?:-|(?=[\s"'\x60]|$))`);
const AXIS_SPACING_HANDLED = /(?:space-x-reverse|divide-x-reverse|\brtl:|\bltr:)/;

/** Dégradé horizontal : sa direction doit être inversée en RTL. */
const HORIZONTAL_GRADIENT = new RegExp(START + String.raw`bg-(?:gradient|linear)-to-(?:r|l|tr|tl|br|bl)\b`);
const GRADIENT_HANDLED = /\brtl:bg-(?:gradient|linear)-to-/;

/** Propriétés CSS physiques (fichiers .css). */
const PHYSICAL_CSS = new RegExp(
  [
    String.raw`^\s*(?:margin|padding|border|scroll-margin|scroll-padding)-(?:left|right)\b`,
    String.raw`^\s*(?:left|right)\s*:`,
    String.raw`^\s*(?:text-align|float|clear)\s*:\s*(?:left|right)\b`,
    String.raw`^\s*border-(?:top|bottom)-(?:left|right)-radius\b`,
  ].join("|"),
);

type Offence = { rule: string; line: number; text: string };

const isCommentLine = (line: string): boolean => /^\s*(?:\/\/|\*|\/\*)/.test(line);

function scanTsx(source: string): Offence[] {
  const out: Offence[] = [];
  source.split("\n").forEach((line, index) => {
    if (isCommentLine(line)) return;
    const n = index + 1;
    const text = line.trim().slice(0, 120);
    if (PHYSICAL_TAILWIND.test(line)) out.push({ rule: "physical-utility", line: n, text });
    if (AXIS_SPACING.test(line) && !AXIS_SPACING_HANDLED.test(line)) out.push({ rule: "axis-spacing-without-rtl", line: n, text });
    if (HORIZONTAL_GRADIENT.test(line) && !GRADIENT_HANDLED.test(line)) out.push({ rule: "gradient-without-rtl", line: n, text });
  });
  return out;
}

function scanCss(source: string): Offence[] {
  const out: Offence[] = [];
  let inBlockComment = false;
  source.split("\n").forEach((line, index) => {
    const n = index + 1;
    const text = line.trim().slice(0, 120);
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      return;
    }
    if (/^\s*\/\*/.test(line)) {
      if (!line.includes("*/")) inBlockComment = true;
      return;
    }
    if (PHYSICAL_CSS.test(line)) out.push({ rule: "physical-css-property", line: n, text });
    // @apply de classes Tailwind physiques
    if (/@apply\b/.test(line) && (PHYSICAL_TAILWIND.test(line.replace(/@apply\s+/, " ")) || AXIS_SPACING.test(line))) {
      out.push({ rule: "physical-utility-in-apply", line: n, text });
    }
  });
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "fonts") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const isTestFile = (file: string): boolean => /\.test\.(?:ts|tsx)$/.test(file);

const files = SCANNED_DIRS.flatMap((dir) => walk(path.join(WEB_ROOT, dir)))
  .filter((file) => !isTestFile(file))
  .map((file) => path.relative(WEB_ROOT, file).split(path.sep).join("/"));

const tsxFiles = files.filter((f) => f.endsWith(".tsx"));
const cssFiles = files.filter((f) => f.endsWith(".css"));

describe("garde RTL : le détecteur repère chaque famille de classe physique (fixtures)", () => {
  it.each([
    ['className="ml-2"', "ml-"],
    ['className="mr-2"', "mr-"],
    ['className="pl-3"', "pl-"],
    ['className="pr-3"', "pr-"],
    ['className="absolute left-0"', "left-"],
    ['className="absolute right-0"', "right-"],
    ['className="text-left"', "text-left"],
    ['className="text-right"', "text-right"],
    ['className="rounded-l-md"', "rounded-l-"],
    ['className="rounded-r-md"', "rounded-r-"],
    ['className="rounded-l"', "rounded-l nu"],
    ['className="rounded-tr-lg"', "rounded-tr-"],
    ['className="rounded-bl-lg"', "rounded-bl-"],
    ['className="border-l"', "border-l nu"],
    ['className="border-r-2"', "border-r-"],
    ['className="float-left"', "float-left"],
    ['className="float-right"', "float-right"],
    ['className="-ml-1"', "marge négative"],
    ['className="sm:pr-4"', "variante responsive"],
    ['className="hover:left-1/2"', "variante d'état"],
    ['className="[&>svg]:mr-2"', "sélecteur arbitraire"],
    ['className="group-data-[x=y]:pl-2"', "variante data"],
    ['className="origin-left"', "origin-left"],
    ['className="clear-right"', "clear-right"],
    ['className="scroll-ml-2"', "scroll-ml-"],
  ])("détecte %s (%s)", (snippet) => {
    expect(scanTsx(snippet).map((o) => o.rule)).toContain("physical-utility");
  });

  it("détecte space-x / divide-x sans inversion RTL, et accepte les formes gérées", () => {
    expect(scanTsx('className="flex space-x-2"').map((o) => o.rule)).toContain("axis-spacing-without-rtl");
    expect(scanTsx('className="flex divide-x"').map((o) => o.rule)).toContain("axis-spacing-without-rtl");
    expect(scanTsx('className="flex space-x-2 space-x-reverse"')).toEqual([]);
    expect(scanTsx('className="flex space-x-2 rtl:space-x-reverse"')).toEqual([]);
    expect(scanTsx('className="flex gap-2"')).toEqual([]);
  });

  it("détecte un dégradé horizontal sans variante rtl: et accepte la forme gérée", () => {
    expect(scanTsx('className="bg-linear-to-r from-a to-b"').map((o) => o.rule)).toContain("gradient-without-rtl");
    expect(scanTsx('className="bg-gradient-to-l from-a"').map((o) => o.rule)).toContain("gradient-without-rtl");
    expect(scanTsx('className="bg-linear-to-r from-a to-b rtl:bg-linear-to-l"')).toEqual([]);
    expect(scanTsx('className="bg-linear-to-b from-a to-b"')).toEqual([]);
  });

  it("n'a pas de faux positifs sur les classes logiques, les variantes rtl: et les animations Radix", () => {
    for (const ok of [
      'className="ms-2 me-2 ps-3 pe-3"',
      'className="start-0 end-0 inset-x-0 inset-s-0"',
      'className="text-start text-end"',
      'className="rounded-s-md rounded-e-md rounded-ss-lg rounded-ee-lg"',
      'className="border-s border-e-2"',
      'className="slide-in-from-left-2 slide-out-to-right-2"',
      'className="rtl:rotate-180 rtl:-scale-x-100 ltr:ml-2"',
      'className="text-primary-text bg-primary text-sm leading-none"',
      'className="data-[side=left]:animate-in"',
      'className="flex-wrap overflow-hidden inline-flex"',
      'className="rightful playleft-widget"',
    ]) {
      const physical = scanTsx(ok).filter((o) => o.rule === "physical-utility");
      // `ltr:ml-2` est le seul cas où la variante explicite ltr: porte une classe physique (autorisé : choix délibéré).
      if (ok.includes("ltr:ml-2")) expect(physical.length).toBe(1);
      else expect(physical, ok).toEqual([]);
    }
  });

  it("ignore les lignes de commentaire", () => {
    expect(scanTsx("// ml-2 pr-4 left-0")).toEqual([]);
    expect(scanTsx(" * text-left")).toEqual([]);
  });

  it("détecte les propriétés CSS physiques et les @apply physiques", () => {
    for (const bad of [
      "  margin-left: 1rem;",
      "  margin-right: 1rem;",
      "  padding-left: 1rem;",
      "  padding-right: 0;",
      "  border-left: 1px solid;",
      "  border-right-width: 2px;",
      "  left: 0;",
      "  right: 0;",
      "  text-align: left;",
      "  text-align: right;",
      "  float: right;",
      "  border-top-left-radius: 4px;",
    ]) {
      expect(scanCss(bad).map((o) => o.rule), bad).toContain("physical-css-property");
    }
    expect(scanCss("  @apply ml-2 flex;").map((o) => o.rule)).toContain("physical-utility-in-apply");
    for (const ok of [
      "  margin-inline-start: 1rem;",
      "  padding-inline: 1rem;",
      "  inset-inline-end: 0;",
      "  text-align: start;",
      "  border-start-start-radius: 4px;",
      "  inline-size: 100%;",
      "  /* margin-left: 1rem; */",
      "  @apply ms-2 flex;",
    ]) {
      expect(scanCss(ok), ok).toEqual([]);
    }
  });

  it("ignore un commentaire CSS sur plusieurs lignes", () => {
    expect(scanCss("/*\n margin-left: 1px;\n text-align: left;\n*/\n.a { margin-inline: 0; }")).toEqual([]);
  });
});

describe("garde RTL : apps/web/components/** et apps/web/app/**", () => {
  it("couvre un nombre plausible de fichiers (la garde n'est pas vide)", () => {
    expect(tsxFiles.length).toBeGreaterThan(40);
    expect(cssFiles).toContain("app/globals.css");
    expect(tsxFiles).toContain("components/ui/sidebar.tsx");
    expect(tsxFiles).toContain("components/members/member-list.tsx");
    expect(tsxFiles).toContain("app/[locale]/layout.tsx");
  });

  it.each(tsxFiles)("%s : aucune utilité Tailwind physique", (file) => {
    const offences = scanTsx(readFileSync(path.join(WEB_ROOT, file), "utf8")).map((o) => `${file}:${o.line} [${o.rule}] ${o.text}`);
    expect(offences).toEqual([]);
  });

  it.each(cssFiles)("%s : aucune propriété CSS physique", (file) => {
    const offences = scanCss(readFileSync(path.join(WEB_ROOT, file), "utf8")).map((o) => `${file}:${o.line} [${o.rule}] ${o.text}`);
    expect(offences).toEqual([]);
  });

  it("liste globale des infractions (fichier:ligne) vide", () => {
    const all = [
      ...tsxFiles.flatMap((f) => scanTsx(readFileSync(path.join(WEB_ROOT, f), "utf8")).map((o) => `${f}:${o.line} [${o.rule}] ${o.text}`)),
      ...cssFiles.flatMap((f) => scanCss(readFileSync(path.join(WEB_ROOT, f), "utf8")).map((o) => `${f}:${o.line} [${o.rule}] ${o.text}`)),
    ];
    expect(all).toEqual([]);
  });
});
