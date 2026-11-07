import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isPhysicalClassToken, physicalClassOffences } from "../ui-audit/class-tokens";
import ar from "./ar.json";
import en from "./en.json";
import fr from "./fr.json";

/**
 * Parité et usage des messages Members.* / Invite.* (J10, agent A4) : chaque clé réellement
 * appelée par les composants et pages existe en ar ET en en ; les variables ICU concordent ; aucun
 * texte en dur dans le JSX ; l'arabe est réellement de l'arabe.
 */
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
type Json = { [k: string]: string | Json };

function flatten(obj: Json, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else for (const [kk, vv] of flatten(v, key)) out.set(kk, vv);
  }
  return out;
}
const AR = flatten(ar as Json);
const EN = flatten(en as Json);
const FR = flatten(fr as Json);

function sources(): string[] {
  const dirs = [path.join(WEB, "components/members"), path.join(WEB, "app/[locale]/(app)/members"), path.join(WEB, "app/[locale]/invite")];
  const files: string[] = [];
  const visit = (p: string) => {
    for (const name of readdirSync(p)) {
      const full = path.join(p, name);
      if (statSync(full).isDirectory()) visit(full);
      else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) files.push(full);
    }
  };
  dirs.forEach(visit);
  return files;
}

/** Clés statiques appelées : `const x = useTranslations("Ns")` / `await getTranslations({ ... namespace: "Ns" })` puis `x("clé")`. */
function usedKeys(): { file: string; key: string }[] {
  const used: { file: string; key: string }[] = [];
  for (const file of sources()) {
    const src = readFileSync(file, "utf8");
    const bindings = [
      ...src.matchAll(/const\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*"([\w.]+)"\s*\)/g),
      ...src.matchAll(/const\s+(\w+)\s*=\s*await\s+getTranslations\(\s*\{[^}]*namespace:\s*"([\w.]+)"[^}]*\}\s*\)/g),
    ];
    for (const [, name, ns] of bindings) {
      for (const call of src.matchAll(new RegExp(`\\b${name}\\(\\s*"([\\w.]+)"`, "g"))) {
        used.push({ file: path.relative(WEB, file), key: `${ns}.${call[1]}` });
      }
    }
  }
  return used;
}

const vars = (s: string) => [...s.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort();
const isMembersKey = (k: string) => k.startsWith("Members.") || k.startsWith("Invite.");

describe("messages Members.* / Invite.* : usage réel", () => {
  const used = usedKeys();

  it("le scan trouve des appels (le test n'est pas vide)", () => {
    expect(used.length).toBeGreaterThan(30);
    expect(sources().length).toBeGreaterThanOrEqual(10);
  });

  it("chaque clé statique appelée existe en ar ET en en, et n'est pas vide", () => {
    const missing = used.flatMap(({ file, key }) => [
      ...(AR.get(key)?.trim() ? [] : [`ar ${key} (${file})`]),
      ...(EN.get(key)?.trim() ? [] : [`en ${key} (${file})`]),
    ]);
    expect(missing).toEqual([]);
  });

  it("parité exacte des clés Members.* / Invite.* entre ar et en", () => {
    const a = [...AR.keys()].filter(isMembersKey).sort();
    const e = [...EN.keys()].filter(isMembersKey).sort();
    expect(a).toEqual(e);
    expect(a.length).toBeGreaterThan(30);
  });

  it("les variables ICU ({name}) sont identiques en ar et en pour chaque clé", () => {
    for (const key of AR.keys()) {
      if (!isMembersKey(key)) continue;
      expect(vars(AR.get(key) ?? ""), key).toEqual(vars(EN.get(key) ?? ""));
      expect(vars(FR.get(key) ?? ""), key).toEqual(vars(EN.get(key) ?? ""));
    }
  });

  it("l'arabe contient de l'arabe (pas de copie de l'anglais) pour les titres et boutons", () => {
    const arabic = /[؀-ۿ]/;
    for (const key of ["Members.title", "Members.invite.title", "Invite.title", "Invite.accept"]) {
      expect(AR.get(key), key).toMatch(arabic);
      expect(EN.get(key), key).not.toMatch(arabic);
      expect(AR.get(key)).not.toBe(EN.get(key));
    }
  });

  it("aucune clé Members.* / Invite.* inutilisée n'est une coquille vide ; les clés d'erreur d'acceptation sont uniques", () => {
    for (const [key, value] of EN) if (isMembersKey(key)) expect(value.trim().length, key).toBeGreaterThan(0);
    const invalidKeys = [...EN.keys()].filter((k) => /invitation_invalid$/.test(k));
    expect(invalidKeys.length).toBeGreaterThan(0);
  });

  it("un seul message d'échec d'acceptation : aucune clé par cause (expiré, révoqué, déjà accepté, e-mail différent, non confirmé)", () => {
    const causeKeys = [...EN.keys()].filter((k) => /^Invite\./.test(k) && /(expired|revoked|accepted|mismatch|unconfirmed|unknown|not_found|email)/i.test(k.replace(/^Invite\.(accept|title|description|hint)$/, "")));
    expect(causeKeys).toEqual([]);
    const errorKeys = [...EN.keys()].filter((k) => k.startsWith("Invite.errors."));
    expect(errorKeys).toEqual(["Invite.errors.invitation_invalid"]);
  });
});

describe("pas de texte en dur dans le JSX des composants Membres / Invitation", () => {
  it("aucun nœud texte littéral (hors espaces, ponctuation et expressions) dans les .tsx", () => {
    const offenders: string[] = [];
    for (const file of sources()) {
      const src = readFileSync(file, "utf8");
      // texte entre > et < qui contient une lettre et n'est pas une expression {…}
      for (const m of src.matchAll(/>([^<>{}\n]*[A-Za-z؀-ۿ][^<>{}\n]*)</g)) {
        const t = (m[1] ?? "").trim();
        // ignorer les génériques TypeScript (ex. Promise<...>) et opérateurs de comparaison
        if (t && !/^[=&|?:;,.()[\]\s]*$/.test(t) && !/=>/.test(t) && !/\b(extends|keyof|typeof)\b/.test(t)) offenders.push(`${path.relative(WEB, file)} : ${t}`);
      }
      // attributs visibles en dur
      for (const m of src.matchAll(/\b(?:aria-label|placeholder|title|alt)="([^"{]+)"/g)) offenders.push(`${path.relative(WEB, file)} : attribut ${m[1]}`);
    }
    expect(offenders).toEqual([]);
  });

  it("styles : plus de module CSS, et aucune classe Tailwind physique (ml-/mr-/pl-/pr-/left-/right-/text-left/text-right/float)", () => {
    const dir = path.join(WEB, "components/members");
    expect(readdirSync(dir).filter((name) => name.endsWith(".css"))).toEqual([]);
    // Balayage de TOUS les littéraux de chaîne du fichier (AST), pas seulement des lignes `className=` / `cn(`.
    const bad = sources().flatMap((file) =>
      physicalClassOffences(file, readFileSync(file, "utf8")).map(({ token, line }) => `${path.relative(WEB, file)}:${line} : ${token}`),
    );
    expect(bad).toEqual([]);
  });

  it("le détecteur AST voit une classe physique dans un gabarit multi-ligne et dans une constante isolée (fixtures)", () => {
    const fixture = [
      'const base = "ps-2 ml-3";',
      "const multi = `",
      "  flex items-center",
      "  ${cond ? 'ms-1' : 'mr-1'}",
      "  text-left",
      "`;",
      'export const X = () => <div className={cn("p-2", multi)} />;',
    ].join("\n");
    const found = physicalClassOffences("fixture.tsx", fixture).map((o) => o.token);
    expect(found).toEqual(expect.arrayContaining(["ml-3", "mr-1", "text-left"]));
    expect(found).not.toContain("ps-2");
    expect(found).not.toContain("ms-1");
    // numéro de ligne dans le gabarit multi-ligne
    expect(physicalClassOffences("fixture.tsx", fixture).find((o) => o.token === "text-left")?.line).toBe(5);
    // variantes, négatif, important
    for (const bad of ["sm:pr-4", "-ml-1", "!left-0", "[&>svg]:mr-2", "rounded-l-md", "border-r", "float-right"]) {
      expect(isPhysicalClassToken(bad), bad).toBe(true);
    }
    for (const ok of ["ms-2", "pe-4", "start-0", "text-start", "rounded-s-md", "border-e", "slide-in-from-left-2", "rtl:rotate-180", "leftover"]) {
      expect(isPhysicalClassToken(ok), ok).toBe(false);
    }
    expect(physicalClassOffences("clean.tsx", 'const a = "ms-2 pe-4"; const b = `text-start`;')).toEqual([]);
  });
});
