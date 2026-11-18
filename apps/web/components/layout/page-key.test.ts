import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import fr from "../../messages/fr.json";
import { NAV_PAGE_KEYS, OTHER_PAGE_KEYS, isNavPageKey, pageKeyOf } from "./page-key";

describe("fil d'Ariane : page courante", () => {
  it.each([
    ["/dashboard", "dashboard"],
    ["/crm", "crmSync"],
    ["/integrations", "integrations"],
    ["/operations", "operations"],
    ["/operations/stop", "operations"],
    ["/assignment", "assignment"],
    ["/notifications", "notifications"],
    ["/imports", "imports"],
    ["/imports/abc", "imports"],
    ["/leads/123", "leads"],
    ["/select-organization", "selectOrganization"],
  ])("%s → %s", (pathname, key) => {
    expect(pageKeyOf(pathname)).toBe(key);
  });

  it("une route inconnue ou un simple préfixe de texte (« /leadsX ») : aucune page", () => {
    expect(pageKeyOf("/leadsX")).toBeNull();
    expect(pageKeyOf("/integrationsX")).toBeNull();
    expect(pageKeyOf("/inconnue")).toBeNull();
  });

  it("chaque entrée de la barre latérale a une page (fil d'Ariane jamais vide)", () => {
    const sidebar = readFileSync(path.join(__dirname, "app-sidebar.tsx"), "utf8");
    const hrefs = [...sidebar.matchAll(/href: "(\/[a-z-]+)"/g)].map((m) => m[1] as string);
    expect(hrefs.length).toBeGreaterThan(8);
    for (const href of hrefs) expect(pageKeyOf(href), href).not.toBeNull();
  });

  it("chaque clé a son libellé en fr / ar / en (nav.* ou pages.*)", () => {
    for (const messages of [fr, ar, en]) {
      const shell = messages.Shell as unknown as { nav: Record<string, string>; pages: Record<string, string> };
      for (const key of NAV_PAGE_KEYS) expect(shell.nav[key], key).toBeTypeOf("string");
      for (const key of OTHER_PAGE_KEYS) expect(shell.pages[key], key).toBeTypeOf("string");
    }
    expect(isNavPageKey("members")).toBe(true);
    expect(isNavPageKey("onboarding")).toBe(false);
  });
});

describe("liens : attribut ARIA adapté", () => {
  it("le lien « File non assignée » de la page Leads utilise aria-current (aria-pressed est réservé aux boutons)", () => {
    const page = readFileSync(path.join(__dirname, "..", "..", "app", "[locale]", "(app)", "leads", "page.tsx"), "utf8");
    expect(page).not.toContain("aria-pressed");
    expect(page).toContain('aria-current={filters.unassigned ? "true" : undefined}');
  });
});
