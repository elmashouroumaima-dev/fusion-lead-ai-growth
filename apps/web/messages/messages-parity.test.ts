import { describe, expect, it } from "vitest";
import ar from "./ar.json";
import en from "./en.json";

type Json = string | { [k: string]: Json };

function flatten(obj: Json, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof obj === "string") {
    out.set(prefix, obj);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    for (const [fk, fv] of flatten(v, prefix ? `${prefix}.${k}` : k)) out.set(fk, fv);
  }
  return out;
}

/** Contenu entre l'accolade ouvrante à `start` et son accolade fermante (équilibrée). */
function balanced(msg: string, start: number): { inner: string; end: number } {
  let depth = 0;
  for (let i = start; i < msg.length; i++) {
    if (msg[i] === "{") depth++;
    else if (msg[i] === "}" && --depth === 0) return { inner: msg.slice(start + 1, i), end: i };
  }
  return { inner: msg.slice(start + 1), end: msg.length };
}

/** Noms d'arguments ICU : {name}, {count, plural, one {…} other {…}} -> count + ceux des branches. */
function collect(msg: string, names: Set<string>): void {
  for (let i = 0; i < msg.length; i++) {
    if (msg[i] !== "{") continue;
    const { inner, end } = balanced(msg, i);
    const head = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,\s*(\w+)\s*(?:,([\s\S]*))?)?$/.exec(inner.split("{")[0] ?? "");
    const name = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:[,}]|$)/.exec(inner)?.[1];
    if (name) names.add(name);
    const type = head?.[2];
    if (type === "plural" || type === "select" || type === "selectordinal") {
      const branches = inner.slice(inner.indexOf(",", inner.indexOf(",") + 1) + 1);
      for (let j = 0; j < branches.length; j++) {
        if (branches[j] === "{") {
          const b = balanced(branches, j);
          collect(b.inner, names);
          j = b.end;
        }
      }
    }
    i = end;
  }
}

function placeholders(msg: string): string[] {
  const names = new Set<string>();
  collect(msg, names);
  return [...names].sort();
}

const arFlat = flatten(ar as Json);
const enFlat = flatten(en as Json);

describe("messages ar/en", () => {
  it("contiennent des clés (garde contre un fichier vide)", () => {
    expect(arFlat.size).toBeGreaterThan(20);
    expect(enFlat.size).toBeGreaterThan(20);
  });

  it("ont exactement les mêmes clés aplaties", () => {
    const a = [...arFlat.keys()].sort();
    const e = [...enFlat.keys()].sort();
    expect(a.filter((k) => !enFlat.has(k))).toEqual([]);
    expect(e.filter((k) => !arFlat.has(k))).toEqual([]);
    expect(a).toEqual(e);
  });

  it.each([
    ["ar", arFlat],
    ["en", enFlat],
  ] as const)("%s : aucune valeur vide", (_l, flat) => {
    const empty = [...flat].filter(([, v]) => v.trim() === "").map(([k]) => k);
    expect(empty).toEqual([]);
  });

  it("ont les mêmes placeholders ICU par clé", () => {
    const diffs: string[] = [];
    for (const [key, value] of arFlat) {
      const other = enFlat.get(key);
      if (other !== undefined && placeholders(value).join(",") !== placeholders(other).join(",")) diffs.push(key);
    }
    expect(diffs).toEqual([]);
  });

  it("l'extracteur de placeholders détecte {name} et {n, plural, ...}", () => {
    expect(placeholders("Bonjour {name}, {count, plural, one {x} other {y}}")).toEqual(["count", "name"]);
    expect(placeholders("{n, plural, one {# {thing}} other {# items}}")).toEqual(["n", "thing"]);
    expect(placeholders("rien")).toEqual([]);
  });

  it("couvre tous les codes d'erreur d'authentification dans les deux langues", () => {
    const codes = ["invalid_input", "invalid_credentials", "email_not_confirmed", "weak_password", "rate_limited", "generic"];
    for (const c of codes) {
      expect(arFlat.has(`Auth.errors.${c}`), `ar ${c}`).toBe(true);
      expect(enFlat.has(`Auth.errors.${c}`), `en ${c}`).toBe(true);
    }
  });

  it("le lien invalide de /auth/confirm a un message traduit (Auth.errors.link_invalid)", () => {
    // Le callback redirige vers /login?error=link_invalid : la page doit pouvoir l'afficher.
    expect(enFlat.has("Auth.errors.link_invalid")).toBe(true);
    expect(arFlat.has("Auth.errors.link_invalid")).toBe(true);
  });

  it("l'arabe n'est pas une copie de l'anglais", () => {
    const allowed = new Set(["Meta.title", "Common.appName", "Home.title"]);
    const same = [...arFlat].filter(([k, v]) => !allowed.has(k) && enFlat.get(k) === v && /[A-Za-z]{4,}/.test(v));
    expect(same.map(([k]) => k)).toEqual([]);
  });
});
