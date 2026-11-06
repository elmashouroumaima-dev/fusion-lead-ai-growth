import { DEFAULT_LOCALE, LOCALES } from "@fusion-leap/domain";
import { describe, expect, it } from "vitest";
import { getDirection } from "./direction";
import { LOCALE_NATIVE_NAMES } from "./locale-names";
import { routing } from "./routing";

describe("routing : source unique des locales", () => {
  it("locales fr, ar, en ; défaut fr ; préfixe toujours présent", () => {
    expect([...routing.locales]).toEqual(["fr", "ar", "en"]);
    expect(routing.defaultLocale).toBe("fr");
    expect(routing.localePrefix).toBe("always");
  });
  it("dérivé de @fusion-leap/domain (pas de littéraux répétés)", () => {
    expect([...routing.locales]).toEqual([...LOCALES]);
    expect(routing.defaultLocale).toBe(DEFAULT_LOCALE);
  });
});

describe("getDirection", () => {
  it.each([
    ["fr", "ltr"],
    ["en", "ltr"],
    ["ar", "rtl"],
  ])("%s -> %s", (locale, dir) => {
    expect(getDirection(locale)).toBe(dir);
  });
  it.each(["AR", "FR", "es", ""])("locale inconnue %j -> ltr", (locale) => {
    expect(getDirection(locale)).toBe("ltr");
  });
});

describe("noms natifs des langues", () => {
  it("chaque locale est nommée dans sa propre langue", () => {
    expect(LOCALE_NATIVE_NAMES).toEqual({ fr: "Français", ar: "العربية", en: "English" });
    expect(Object.keys(LOCALE_NATIVE_NAMES).sort()).toEqual([...LOCALES].sort());
  });
});
