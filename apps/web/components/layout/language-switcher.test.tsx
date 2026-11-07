import { beforeEach, describe, expect, it, vi } from "vitest";

let currentLocale = "fr";
vi.mock("next-intl", () => ({
  useLocale: () => currentLocale,
  useTranslations: () => (key: string) => `T:${key}`,
}));
vi.mock("../../i18n/navigation", () => ({
  Link: "a",
  usePathname: () => "/dashboard",
}));

import { LanguageSwitcher } from "./language-switcher";

type El = { type?: unknown; props?: { children?: unknown; [k: string]: unknown } };
function links(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => links(n, out));
  else if (node && typeof node === "object" && "props" in node) {
    const el = node as El;
    if (el.type === "a") out.push(el);
    links(el.props?.children, out);
  }
  return out;
}

beforeEach(() => {
  currentLocale = "fr";
});

describe("LanguageSwitcher", () => {
  it.each([
    ["fr", ["ar", "en"]],
    ["ar", ["fr", "en"]],
    ["en", ["fr", "ar"]],
  ])("depuis %s : propose les deux autres locales", (locale, expected) => {
    currentLocale = locale;
    const found = links(LanguageSwitcher());
    expect(found.map((l) => l.props?.locale)).toEqual(expected);
    for (const l of found) {
      expect(l.props?.hrefLang).toBe(l.props?.locale);
      expect(l.props?.lang).toBe(l.props?.locale);
      expect(l.props?.href).toBe("/dashboard");
    }
  });

  it("chaque lien porte le nom de la langue dans sa propre langue", () => {
    const names = Object.fromEntries(links(LanguageSwitcher()).map((l) => [l.props?.locale, l.props?.children]));
    expect(names).toEqual({ ar: "العربية", en: "English" });
    currentLocale = "ar";
    const fromAr = Object.fromEntries(links(LanguageSwitcher()).map((l) => [l.props?.locale, l.props?.children]));
    expect(fromAr).toEqual({ fr: "Français", en: "English" });
  });

  it("le déclencheur du menu est étiqueté et aucun repère <nav> supplémentaire n'est créé", () => {
    const all: El[] = [];
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(collect);
      else if (node && typeof node === "object" && "props" in node) {
        all.push(node as El);
        collect((node as El).props?.children);
      }
    };
    collect(LanguageSwitcher());
    expect(all.some((e) => e.type === "nav")).toBe(false);
    expect(all.some((e) => e.props?.["aria-label"] === "T:label")).toBe(true);
  });
});
