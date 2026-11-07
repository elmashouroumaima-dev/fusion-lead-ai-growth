import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import fr from "../../messages/fr.json";

const WEB_ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(path.join(WEB_ROOT, rel), "utf8");

/** Clés `Shell.*` utilisées littéralement par les composants de la coquille. */
const SHELL_SOURCES = [
  "components/layout/app-shell.tsx",
  "components/layout/app-sidebar.tsx",
  "components/layout/user-menu.tsx",
  "components/theme/theme-toggle.tsx",
];

function lookup(root: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), root);
}

describe("coquille d'application : messages", () => {
  it.each(SHELL_SOURCES)("%s : chaque clé littérale existe en fr / ar / en", (rel) => {
    const src = read(rel);
    const nsMatches = [...src.matchAll(/useTranslations\("(Shell(?:\.[A-Za-z]+)?)"\)/g)].map((m) => m[1] as string);
    expect(nsMatches.length).toBeGreaterThan(0);
    const ns = nsMatches[0] as string;
    const keys = [...src.matchAll(/\bt\("([A-Za-z0-9_.]+)"\)/g)].map((m) => m[1] as string);
    for (const key of keys) {
      for (const [name, messages] of [["fr", fr], ["ar", ar], ["en", en]] as const) {
        expect(lookup(messages, `${ns}.${key}`), `${name} ${ns}.${key}`).toBeTypeOf("string");
      }
    }
  });

  it("clés dynamiques de navigation et de pages présentes dans les trois langues", () => {
    for (const messages of [fr, ar, en]) {
      for (const k of ["nav.dashboard", "nav.members", "pages.onboarding", "pages.selectOrganization"]) {
        expect(lookup(messages.Shell, k), k).toBeTypeOf("string");
      }
    }
  });

  it("le sélecteur de thème propose clair, sombre et système, et mémorise sous fl-theme", () => {
    const provider = read("components/theme/theme-provider.tsx");
    expect(provider).toContain('storageKey="fl-theme"');
    expect(provider).toContain('defaultTheme="system"');
    expect(provider).toContain('attribute="class"');
    const toggle = read("components/theme/theme-toggle.tsx");
    for (const v of ["light", "dark", "system"]) expect(toggle).toContain(`value="${v}"`);
  });

  it("la barre latérale suit la direction (côté logique par défaut) et « Membres » est conditionnel", () => {
    const sidebar = read("components/ui/sidebar.tsx");
    expect(sidebar).toContain('side = "start"');
    const appSidebar = read("components/layout/app-sidebar.tsx");
    expect(appSidebar).toMatch(/showMembers\s*\?/);
    expect(appSidebar).toContain('href: "/members"');
  });

  it("le layout racine : suppressHydrationWarning, direction, polices locales, lien d'évitement", () => {
    const layout = read("app/[locale]/layout.tsx");
    expect(layout).toContain("suppressHydrationWarning");
    expect(layout).toContain("dir={dir}");
    expect(layout).toContain('href="#main"');
    const fonts = read("app/fonts/fonts.ts");
    expect(fonts).toContain("next/font/local");
    expect(fonts).not.toContain("next/font/google");
  });
});
