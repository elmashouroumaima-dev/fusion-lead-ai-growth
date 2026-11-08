import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import ar from "../messages/ar.json";
import en from "../messages/en.json";
import fr from "../messages/fr.json";

/**
 * Textes de l'interface (ADR 011) :
 *  1. aucune chaîne visible en dur dans les .tsx de components/ et app/ (texte JSX, attributs accessibles,
 *     valeurs par défaut de paramètres libellés) ;
 *  2. chaque clé de message appelée littéralement existe en fr, ar ET en ;
 *  3. parité complète des catalogues (clés, valeurs non vides, paramètres ICU identiques, arabe réellement arabe).
 */
const WEB_ROOT = path.resolve(__dirname, "..");
const SCANNED = ["components", "app"] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "fonts") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const tsxFiles = SCANNED.flatMap((d) => walk(path.join(WEB_ROOT, d)))
  .map((f) => path.relative(WEB_ROOT, f).split(path.sep).join("/"))
  .filter((f) => f.endsWith(".tsx") && !/\.test\.tsx$/.test(f));

const parse = (source: string, name = "x.tsx"): ts.SourceFile => ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const hasLetters = (s: string): boolean => /[\p{L}]/u.test(s);

// --------------------------------------------------------------------------------------------------
// 1. Chaînes en dur
// --------------------------------------------------------------------------------------------------

/** Textes volontairement non traduits : noms de marque. */
const ALLOWED_LITERALS = new Set(["Fusion Leap"]);

/** Attributs / propriétés qui portent du texte lu par l'utilisateur ou par un lecteur d'écran. */
const TEXT_ATTRIBUTES = new Set([
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "title",
  "placeholder",
  "alt",
  "label",
  "closeLabel",
  "mobileTitle",
  "mobileDescription",
  "description",
  "content",
]);

type Hit = { line: number; kind: string; text: string };

function hardCoded(source: string): Hit[] {
  const sf = parse(source);
  const hits: Hit[] = [];
  const at = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const record = (node: ts.Node, kind: string, text: string): void => {
    const t = text.replace(/\s+/g, " ").trim();
    if (!hasLetters(t) || ALLOWED_LITERALS.has(t)) return;
    hits.push({ line: at(node), kind, text: t.slice(0, 60) });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) record(node, "jsx-text", node.getText(sf));
    if (ts.isJsxExpression(node) && node.expression && ts.isStringLiteralLike(node.expression) && ts.isJsxElement(node.parent)) {
      record(node, "jsx-string-child", node.expression.text);
    }
    if (ts.isJsxAttribute(node) && TEXT_ATTRIBUTES.has(node.name.getText(sf)) && node.initializer) {
      const init = node.initializer;
      if (ts.isStringLiteral(init)) record(node, `attr:${node.name.getText(sf)}`, init.text);
      else if (ts.isJsxExpression(init) && init.expression && ts.isStringLiteralLike(init.expression)) {
        record(node, `attr:${node.name.getText(sf)}`, init.expression.text);
      }
    }
    // valeurs par défaut de paramètres libellés : ({ closeLabel = "Close" })
    if ((ts.isBindingElement(node) || ts.isParameter(node)) && node.initializer && ts.isStringLiteralLike(node.initializer)) {
      const name = node.name.getText(sf);
      if (TEXT_ATTRIBUTES.has(name)) record(node, `default:${name}`, node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe("chaînes en dur : le détecteur (fixtures)", () => {
  it("repère texte JSX, chaîne enfant, attributs accessibles et valeurs par défaut", () => {
    const kinds = (src: string) => hardCoded(src).map((h) => h.kind);
    expect(kinds("const a = <p>Hello</p>;")).toEqual(["jsx-text"]);
    expect(kinds("const a = <p>{'Hello'}</p>;")).toEqual(["jsx-string-child"]);
    expect(kinds('const a = <button aria-label="Close" />;')).toEqual(["attr:aria-label"]);
    expect(kinds('const a = <input placeholder="Search" />;')).toEqual(["attr:placeholder"]);
    expect(kinds("const a = <img alt={'Logo'} />;")).toEqual(["attr:alt"]);
    expect(kinds('const a = <Dialog closeLabel="Close" />;')).toEqual(["attr:closeLabel"]);
    expect(kinds('function F({ closeLabel = "Close" }: { closeLabel?: string }) { return null; }')).toEqual(["default:closeLabel"]);
    expect(kinds("const a = <p>مرحبا</p>;")).toEqual(["jsx-text"]);
    expect(kinds("const a = <p>Bonjour <b>{name}</b></p>;")).toEqual(["jsx-text"]);
  });

  it("n'a pas de faux positif sur messages traduits, symboles, classes, marque et valeurs techniques", () => {
    for (const ok of [
      "const a = <p>{t('hello')}</p>;",
      "const a = <p>—</p>;",
      "const a = <p>·</p>;",
      "const a = <p>(</p>;",
      "const a = <span className=\"sr-only\">{label}</span>;",
      'const a = <Brand>Fusion Leap</Brand>;',
      'const a = <input type="email" name="email" autoComplete="email" dir="ltr" />;',
      'const a = <a href="#main" lang="fr" hrefLang="fr" />;',
      'const a = <Dialog aria-label={t("x")} closeLabel={t("close")} />;',
      "const a = <p>   </p>;",
      "const x = { title: 'metadata' };",
    ]) {
      expect(hardCoded(ok), ok).toEqual([]);
    }
  });
});

describe("chaînes en dur : apps/web/components/** et apps/web/app/**", () => {
  it("la garde n'est pas vide", () => {
    expect(tsxFiles.length).toBeGreaterThan(40);
    expect(tsxFiles).toContain("components/ui/sidebar.tsx");
    expect(tsxFiles).toContain("components/auth/auth-form.tsx");
  });

  for (const file of tsxFiles) {
    it(`${file} : aucun texte visible en dur`, () => {
      const hits = hardCoded(readFileSync(path.join(WEB_ROOT, file), "utf8")).map((h) => `${file}:${h.line} [${h.kind}] « ${h.text} »`);
      expect(hits).toEqual([]);
    });
  }
});

// --------------------------------------------------------------------------------------------------
// 2. Clés appelées littéralement
// --------------------------------------------------------------------------------------------------

const CATALOGS = { fr, ar, en } as const;

function lookup(root: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), root);
}

type KeyUse = { line: number; full: string; dynamic: boolean };

/**
 * Associe `const t = useTranslations("NS")` / `await getTranslations("NS")` aux appels `t("clé")`, PAR FONCTION :
 * deux composants d'un même fichier peuvent nommer `t` des traducteurs d'espaces de noms différents.
 */
function translationUses(source: string): KeyUse[] {
  const sf = parse(source);
  const scopes = new Map<ts.Node, Map<string, string>>();
  const unwrap = (e: ts.Expression): ts.Expression => (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e);
  const isScope = (n: ts.Node): boolean =>
    ts.isArrowFunction(n) || ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n) || ts.isSourceFile(n);
  const scopeOf = (n: ts.Node): ts.Node => {
    let cur: ts.Node | undefined = n.parent;
    while (cur && !isScope(cur)) cur = cur.parent;
    return cur ?? sf;
  };
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrap(node.initializer);
      if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && ["useTranslations", "getTranslations"].includes(init.expression.text)) {
        const arg = init.arguments[0];
        let ns: string | undefined;
        if (arg && ts.isStringLiteralLike(arg)) ns = arg.text;
        else if (arg && ts.isObjectLiteralExpression(arg)) {
          for (const p of arg.properties) {
            if (ts.isPropertyAssignment(p) && p.name.getText(sf) === "namespace" && ts.isStringLiteralLike(p.initializer)) ns = p.initializer.text;
          }
        }
        if (ns !== undefined) {
          const scope = scopeOf(node);
          const map = scopes.get(scope) ?? new Map<string, string>();
          map.set(node.name.text, ns);
          scopes.set(scope, map);
        }
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const resolve = (call: ts.CallExpression, name: string): string | undefined => {
    let cur: ts.Node | undefined = call;
    while (cur) {
      if (isScope(cur)) {
        const found = scopes.get(cur)?.get(name);
        if (found !== undefined) return found;
      }
      cur = cur.parent;
    }
    return undefined;
  };

  const uses: KeyUse[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const ns = resolve(node, node.expression.text);
      const arg = node.arguments[0];
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      if (ns !== undefined && arg && ts.isStringLiteralLike(arg)) uses.push({ line, full: `${ns}.${arg.text}`, dynamic: false });
      else if (ns !== undefined && arg && ts.isTemplateExpression(arg)) uses.push({ line, full: `${ns}.${arg.head.text}`, dynamic: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return uses;
}

describe("clés de messages : le repérage (fixtures)", () => {
  it("distingue deux traducteurs homonymes de portées différentes dans un même fichier", () => {
    const uses = translationUses(
      'function A() { const t = useTranslations("Auth"); return t("x"); }\n' +
        'function B() { const t = useTranslations("Auth.fields"); return t("y"); }\n' +
        'async function C() { const t = await getTranslations({ locale, namespace: "Meta" }); return t("z"); }',
    );
    expect(uses.map((u) => u.full)).toEqual(["Auth.x", "Auth.fields.y", "Meta.z"]);
  });

  it("résout l'espace de noms, les clés littérales et les préfixes dynamiques", () => {
    const uses = translationUses(
      'const t = useTranslations("Shell"); const tc = await getTranslations({ locale, namespace: "Common" });\n' +
        'x(t("nav.label"), tc("appName"), t(`nav.${k}`), other("zzz"));',
    );
    expect(uses.map((u) => u.full)).toEqual(["Shell.nav.label", "Common.appName", "Shell.nav."]);
    expect(uses.map((u) => u.dynamic)).toEqual([false, false, true]);
  });
});

describe("clés de messages : chaque appel existe en fr / ar / en", () => {
  const withUses = tsxFiles
    .map((file) => ({ file, uses: translationUses(readFileSync(path.join(WEB_ROOT, file), "utf8")) }))
    .filter((x) => x.uses.length > 0);

  it("la garde trouve des appels (pas de faux vert)", () => {
    expect(withUses.length).toBeGreaterThan(15);
    expect(withUses.flatMap((x) => x.uses).length).toBeGreaterThan(150);
  });

  it.each(withUses.map((x) => [x.file, x.uses] as const))("%s", (_file, uses) => {
    const missing: string[] = [];
    for (const use of uses) {
      const path = use.dynamic ? use.full.replace(/\.$/, "") : use.full;
      for (const [locale, catalog] of Object.entries(CATALOGS)) {
        const value = lookup(catalog, path);
        if (use.dynamic) {
          if (!value || typeof value !== "object") missing.push(`${locale}:${use.full}* (L${use.line})`);
        } else if (typeof value !== "string") {
          missing.push(`${locale}:${use.full} (L${use.line})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("une clé inexistante serait détectée (contre-épreuve)", () => {
    expect(lookup(fr, "Shell.nav.nope")).toBeUndefined();
    expect(lookup(fr, "Shell.nav.label")).toBeTypeOf("string");
  });
});

// --------------------------------------------------------------------------------------------------
// 3. Parité des catalogues
// --------------------------------------------------------------------------------------------------

function flatten(node: unknown, prefix = "", out = new Map<string, string>()): Map<string, string> {
  if (typeof node === "string") out.set(prefix, node);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

const flat = { fr: flatten(fr), ar: flatten(ar), en: flatten(en) };
/** Paramètres ICU `{name}` (hors balises plurielles : on compare les noms de premier niveau). */
const params = (value: string): string[] => [...new Set([...value.matchAll(/\{\s*(\w+)\s*[,}]/g)].map((m) => m[1] as string))].sort();

describe("catalogues fr / ar / en : parité", () => {
  it("les trois catalogues ont exactement les mêmes clés", () => {
    const frKeys = [...flat.fr.keys()].sort();
    expect([...flat.ar.keys()].sort()).toEqual(frKeys);
    expect([...flat.en.keys()].sort()).toEqual(frKeys);
    expect(frKeys.length).toBeGreaterThan(180);
  });

  it("l'espace de noms Shell existe, complet, dans les trois langues", () => {
    for (const locale of ["fr", "ar", "en"] as const) {
      const keys = [...flat[locale].keys()].filter((k) => k.startsWith("Shell."));
      expect(keys.length, locale).toBeGreaterThanOrEqual(18);
    }
  });

  it.each(["fr", "ar", "en"] as const)("%s : aucune valeur vide ni espaces seuls", (locale) => {
    const empty = [...flat[locale]].filter(([, v]) => v.trim() === "").map(([k]) => k);
    expect(empty).toEqual([]);
  });

  it("les paramètres ICU sont identiques dans les trois langues pour chaque clé", () => {
    const mismatches: string[] = [];
    for (const [key, frValue] of flat.fr) {
      const expected = params(frValue);
      for (const locale of ["ar", "en"] as const) {
        const got = params(flat[locale].get(key) ?? "");
        if (JSON.stringify(got) !== JSON.stringify(expected)) mismatches.push(`${locale}:${key} {${got}} != fr {${expected}}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("l'arabe est de l'arabe : chaque valeur contenant des lettres latines en anglais contient aussi de l'arabe (hors noms propres)", () => {
    const PROPER = new Set(["Fusion Leap", "Fusion Leap AI Growth"]);
    const bad: string[] = [];
    for (const [key, arValue] of flat.ar) {
      const enValue = flat.en.get(key) ?? "";
      if (!/[A-Za-z]/.test(enValue) || PROPER.has(enValue)) continue;
      if (!/[؀-ۿ]/.test(arValue)) bad.push(`${key} = « ${arValue} »`);
    }
    expect(bad).toEqual([]);
  });

  it("le français et l'anglais ne sont pas des copies l'un de l'autre (valeurs traduites)", () => {
    // Termes identiques en français et en anglais (anglicismes usuels du métier : « Leads », « Deals », « Source », « Contact »).
    const SAME_OK = new Set(["Fusion Leap", "Fusion Leap AI Growth", "Leads", "Deals", "Source", "Contact", "Pagination"]);
    const same = [...flat.fr].filter(([k, v]) => v === flat.en.get(k) && /[A-Za-z]{4,}/.test(v) && !SAME_OK.has(v)).map(([k]) => k);
    expect(same).toEqual([]);
  });

  it("la contre-épreuve : une clé manquante ou un paramètre différent serait détecté", () => {
    expect(params("Lien valable {days} jours, pour {email}")).toEqual(["days", "email"]);
    expect(params("sans paramètre")).toEqual([]);
    expect(params("{count, plural, one {# élément} other {# éléments}}")).toEqual(["count"]);
  });
});
