import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Jetons de design (ADR 015) : app/globals.css.
 *  - chaque jeton lu par `@theme inline` existe dans `:root` ; chaque jeton de couleur est redéfini dans `.dark`
 *    (ou figure, explicitement, dans la liste des jetons volontairement hérités du clair) ;
 *  - contraste WCAG AA (4.5:1 pour le texte, 3:1 pour l'anneau de focus) en clair ET en sombre.
 */
const WEB_ROOT = path.resolve(__dirname, "..");
const CSS = readFileSync(path.join(WEB_ROOT, "app", "globals.css"), "utf8");

// --------------------------------------------------------------------------------------------------
// Analyse minimale du CSS (blocs à accolades, déclarations de variables)
// --------------------------------------------------------------------------------------------------

/** Contenu du premier bloc dont l'en-tête est exactement `header` (accolades équilibrées). */
function blockOf(css: string, header: string): string | null {
  const re = new RegExp(`(?:^|\\n)${header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`);
  const match = re.exec(css);
  if (!match) return null;
  let depth = 1;
  let i = match.index + match[0].length;
  const start = i;
  while (i < css.length && depth > 0) {
    const ch = css[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    i += 1;
  }
  return depth === 0 ? css.slice(start, i - 1) : null;
}

function declarations(block: string): Map<string, string> {
  const withoutComments = block.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map<string, string>();
  for (const m of withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1] as string, (m[2] as string).trim());
  return out;
}

// --------------------------------------------------------------------------------------------------
// Contraste WCAG 2.x
// --------------------------------------------------------------------------------------------------

function parseHex(value: string): [number, number, number] {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())?.[1];
  if (!hex) throw new Error(`couleur hexadécimale attendue, reçu « ${value} »`);
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  return [0, 2, 4].map((o) => parseInt(full.slice(o, o + 2), 16)) as [number, number, number];
}

function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const la = luminance(parseHex(a));
  const lb = luminance(parseHex(b));
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// --------------------------------------------------------------------------------------------------
// Données
// --------------------------------------------------------------------------------------------------

const rootBlock = blockOf(CSS, ":root");
const darkBlock = blockOf(CSS, ".dark");
const themeBlock = blockOf(CSS, "@theme inline");

const root = declarations(rootBlock ?? "");
const dark = declarations(darkBlock ?? "");
const theme = declarations(themeBlock ?? "");
/** Valeurs effectives en thème sombre : `.dark` surcharge `:root` (cascade). */
const effectiveDark = new Map([...root, ...dark]);

/** Jetons de couleur volontairement non redéfinis en sombre (identiques au clair). */
const INHERITED_FROM_LIGHT_OK = new Set([
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
]);

const varRefs = (value: string): string[] => [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1] as string);

// --------------------------------------------------------------------------------------------------

describe("jetons : analyse du CSS", () => {
  it("trouve les trois blocs attendus", () => {
    expect(rootBlock).not.toBeNull();
    expect(darkBlock).not.toBeNull();
    expect(themeBlock).not.toBeNull();
    expect(root.size).toBeGreaterThan(30);
    expect(dark.size).toBeGreaterThan(15);
    expect(theme.size).toBeGreaterThan(30);
  });

  it("blockOf gère les accolades imbriquées et un en-tête absent (fixtures)", () => {
    const css = ".a {\n  --x: 1;\n}\n@media (x) {\n  .b { --y: 2; }\n}\n.dark {\n  --z: #fff;\n}\n";
    expect(declarations(blockOf(css, ".dark") ?? "").get("--z")).toBe("#fff");
    expect(blockOf(css, ".absent")).toBeNull();
    expect(blockOf(":root:lang(ar) {\n --a: 1;\n}", ":root")).toBeNull();
  });
});

describe("jetons : @theme inline <-> :root <-> .dark", () => {
  const themeColorEntries = [...theme].filter(([name]) => name.startsWith("--color-"));

  it("@theme inline expose des couleurs", () => {
    expect(themeColorEntries.length).toBeGreaterThan(25);
  });

  it.each(themeColorEntries)("%s -> %s : défini dans :root", (name, value) => {
    const refs = varRefs(value);
    expect(refs.length, `${name} doit référencer une variable`).toBeGreaterThan(0);
    for (const ref of refs) expect(root.has(ref), `${name} -> ${ref} absent de :root`).toBe(true);
  });

  it.each(themeColorEntries)("%s -> %s : défini dans .dark, ou hérité du clair de façon déclarée", (name, value) => {
    for (const ref of varRefs(value)) {
      const inherited = INHERITED_FROM_LIGHT_OK.has(ref);
      expect(dark.has(ref) || inherited, `${ref} (lu par ${name}) n'est pas redéfini dans .dark ni déclaré hérité`).toBe(true);
      // la liste d'héritage ne doit pas masquer un jeton qui est en fait redéfini
      if (inherited) expect(dark.has(ref), `${ref} est redéfini dans .dark : le retirer de la liste d'héritage`).toBe(false);
    }
  });

  it("tous les autres jetons lus par @theme (rayons, ombres, police) existent dans :root", () => {
    for (const [name, value] of theme) {
      if (name.startsWith("--color-")) continue;
      for (const ref of varRefs(value)) expect(root.has(ref), `${name} -> ${ref}`).toBe(true);
    }
  });

  it("chaque jeton de .dark existe dans :root (pas de faute de frappe)", () => {
    for (const name of dark.keys()) expect(root.has(name), `${name} est défini dans .dark mais pas dans :root`).toBe(true);
  });

  it("la bordure décorative (--border) reste plus claire que la bordure des champs (--input)", () => {
    for (const values of [root, effectiveDark]) {
      const bg = values.get("--background") as string;
      expect(contrast(values.get("--border") as string, bg)).toBeLessThan(contrast(values.get("--input") as string, bg));
    }
  });

  it("les jetons de couleur de :root sont des couleurs hexadécimales valides en clair et en sombre", () => {
    for (const [, value] of themeColorEntries) {
      const ref = varRefs(value)[0] as string;
      expect(() => parseHex(root.get(ref) as string), `${ref} (clair)`).not.toThrow();
      expect(() => parseHex(effectiveDark.get(ref) as string), `${ref} (sombre)`).not.toThrow();
    }
  });
});

describe("contraste WCAG (fixtures de la fonction)", () => {
  it("noir sur blanc = 21:1, identique = 1:1, #777 sur blanc ~ 4.48:1 (sous AA)", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrast("#777777", "#ffffff")).toBeGreaterThan(4.4);
    expect(contrast("#777777", "#ffffff")).toBeLessThan(4.5);
    expect(contrast("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("est symétrique et accepte #rgb", () => {
    expect(contrast("#fff", "#000")).toBeCloseTo(contrast("#000", "#fff"), 8);
  });
});

type Pair = { fg: string; bg: string; min: number; why: string };

const TEXT = 4.5;
const UI = 3;

const PAIRS: Pair[] = [
  { fg: "--foreground", bg: "--background", min: TEXT, why: "texte courant" },
  { fg: "--card-foreground", bg: "--card", min: TEXT, why: "texte de carte" },
  { fg: "--popover-foreground", bg: "--popover", min: TEXT, why: "texte de menu/popover" },
  { fg: "--primary-foreground", bg: "--primary", min: TEXT, why: "bouton principal" },
  { fg: "--secondary-foreground", bg: "--secondary", min: TEXT, why: "bouton secondaire" },
  { fg: "--muted-foreground", bg: "--background", min: TEXT, why: "texte atténué sur le fond" },
  { fg: "--muted-foreground", bg: "--card", min: TEXT, why: "texte atténué sur carte" },
  { fg: "--muted-foreground", bg: "--muted", min: TEXT, why: "texte atténué sur zone atténuée" },
  { fg: "--accent-foreground", bg: "--accent", min: TEXT, why: "élément survolé" },
  { fg: "--destructive-foreground", bg: "--destructive", min: TEXT, why: "bouton destructif" },
  { fg: "--sidebar-foreground", bg: "--sidebar", min: TEXT, why: "barre latérale" },
  { fg: "--sidebar-primary-foreground", bg: "--sidebar-primary", min: TEXT, why: "élément actif de barre latérale" },
  { fg: "--sidebar-accent-foreground", bg: "--sidebar-accent", min: TEXT, why: "survol de barre latérale" },
  { fg: "--primary-text-color", bg: "--background", min: TEXT, why: "liens / texte vert sur le fond" },
  { fg: "--primary-text-color", bg: "--card", min: TEXT, why: "liens / texte vert sur carte" },
  { fg: "--destructive-text", bg: "--background", min: TEXT, why: "texte d'erreur sur le fond" },
  { fg: "--destructive-text", bg: "--card", min: TEXT, why: "texte d'erreur sur carte" },
  { fg: "--destructive-text", bg: "--popover", min: TEXT, why: "texte d'erreur dans un popover" },
  { fg: "--input", bg: "--background", min: UI, why: "bordure des champs sur le fond (WCAG 1.4.11)" },
  { fg: "--input", bg: "--card", min: UI, why: "bordure des champs sur carte (WCAG 1.4.11)" },
  { fg: "--ring", bg: "--background", min: UI, why: "anneau de focus (composant d'interface, WCAG 1.4.11)" },
  { fg: "--sidebar-ring", bg: "--sidebar", min: UI, why: "anneau de focus de la barre latérale" },
];

describe.each([
  ["clair", root],
  ["sombre", effectiveDark],
] as const)("contraste AA, thème %s", (_theme, values) => {
  it.each(PAIRS)("$fg sur $bg >= $min:1 ($why)", ({ fg, bg, min }) => {
    const fgValue = values.get(fg);
    const bgValue = values.get(bg);
    expect(fgValue, `${fg} manquant`).toBeDefined();
    expect(bgValue, `${bg} manquant`).toBeDefined();
    const ratio = contrast(fgValue as string, bgValue as string);
    expect(ratio, `${fg} ${fgValue} sur ${bg} ${bgValue} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(min);
  });
});

describe("contraste : cas d'usage dérivés du code", () => {
  it("le texte d'erreur (--destructive-text) est lisible sur le fond et les cartes, en clair ET en sombre", () => {
    for (const values of [root, effectiveDark]) {
      for (const bg of ["--background", "--card"]) {
        expect(contrast(values.get("--destructive-text") as string, values.get(bg) as string)).toBeGreaterThanOrEqual(TEXT);
      }
    }
  });

  it("--destructive reste un fond de bouton : seul, il n'est pas utilisable en texte sombre (d'où --destructive-text)", () => {
    // #b91c1c sur #09090b est sous AA : c'est la raison d'être du jeton --destructive-text.
    const raw = contrast(effectiveDark.get("--destructive") as string, effectiveDark.get("--background") as string);
    expect(raw).toBeLessThan(TEXT);
  });

  it("le vert de marque brut (--primary) n'est PAS utilisable en texte sur fond sombre : d'où --primary-text-color", () => {
    const rawOnDark = contrast(effectiveDark.get("--primary") as string, effectiveDark.get("--background") as string);
    expect(rawOnDark).toBeLessThan(TEXT);
    expect(contrast(effectiveDark.get("--primary-text-color") as string, effectiveDark.get("--background") as string)).toBeGreaterThanOrEqual(TEXT);
  });
});

// --------------------------------------------------------------------------------------------------
// Usages dans le code : le texte `text-destructive` doit avoir un équivalent lisible en sombre
// --------------------------------------------------------------------------------------------------


function tsxUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) tsxUnder(full, out);
    else if (full.endsWith(".tsx") && !full.endsWith(".test.tsx")) out.push(full);
  }
  return out;
}

/** `text-destructive` (avec ou sans variante) : interdit, y compris doublé d'un `dark:text-...` (le jeton --destructive-text suffit). */
const BARE_DESTRUCTIVE_TEXT = /(?:^|[\s"'`:\]])text-destructive(?![\w/-])/;

function bareDestructiveLines(source: string): number[] {
  return source
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !/^\s*(?:\/\/|\*|\/\*)/.test(line) && BARE_DESTRUCTIVE_TEXT.test(line))
    .map(({ n }) => n);
}

describe("usages de text-destructive (contraste en sombre)", () => {
  it("le détecteur distingue `text-destructive` de `text-destructive-text` (fixtures)", () => {
    expect(bareDestructiveLines('<p className="text-destructive text-sm">')).toEqual([1]);
    expect(bareDestructiveLines('<p className="text-destructive text-sm dark:text-red-300">')).toEqual([1]);
    expect(bareDestructiveLines('<p className="text-destructive-text text-sm">')).toEqual([]);
    expect(bareDestructiveLines('<p className="data-[variant=destructive]:text-destructive">')).toEqual([1]);
    expect(bareDestructiveLines('<p className="bg-destructive text-destructive-foreground">')).toEqual([]);
    expect(bareDestructiveLines('<p className="border-destructive/40">')).toEqual([]);
    expect(bareDestructiveLines("// text-destructive")).toEqual([]);
  });

  it("aucun `text-destructive` nu dans components/ et app/ : le texte d'erreur utilise `text-destructive-text`", () => {
    const offences: string[] = [];
    for (const dir of ["components", "app"]) {
      for (const file of tsxUnder(path.join(WEB_ROOT, dir))) {
        for (const n of bareDestructiveLines(readFileSync(file, "utf8"))) {
          offences.push(`${path.relative(WEB_ROOT, file).split(path.sep).join("/")}:${n}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });
});

describe("contraste des composants non textuels (WCAG 1.4.11, 3:1)", () => {
  it("la bordure des champs (--input) atteint 3:1 contre le fond, en clair et en sombre", () => {
    for (const values of [root, effectiveDark]) {
      expect(contrast(values.get("--input") as string, values.get("--background") as string)).toBeGreaterThanOrEqual(UI);
    }
  });
});

describe("notifications : succes vert, erreur rouge, en haut", () => {
  const pairs: [string, string][] = [
    ["--success", "--success-foreground"],
    ["--destructive", "--destructive-foreground"],
  ];

  it.each(pairs)("%s / %s : contraste AA (4.5:1) en clair et en sombre", (bg, fg) => {
    expect(contrast(root.get(bg) as string, root.get(fg) as string), `clair ${bg}`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(effectiveDark.get(bg) as string, effectiveDark.get(fg) as string), `sombre ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it("le vert du succes est un jeton propre, defini en clair et en sombre, expose a Tailwind", () => {
    expect(root.has("--success")).toBe(true);
    expect(dark.has("--success")).toBe(true);
    expect(theme.get("--color-success")).toBe("var(--success)");
  });

  it("le composant Toaster se place en haut, colore succes et erreur par les jetons", () => {
    const src = readFileSync(path.join(WEB_ROOT, "components", "ui", "sonner.tsx"), "utf8");
    expect(src).toContain('position="top-center"');
    expect(src).toContain("richColors");
    expect(src).toContain('"--success-bg": "var(--success)"');
    expect(src).toContain('"--error-bg": "var(--destructive)"');
  });
});
