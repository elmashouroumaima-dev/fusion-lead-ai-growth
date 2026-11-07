import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE as DOMAIN_DEFAULT, LOCALES } from "@fusion-leap/domain";
import { DEFAULT_LOCALE, isGuestOnlyPath, isPublicPath, normalizePathname, parseLocalePath } from "./routes";

describe("locales : source unique", () => {
  it("fr est la locale par défaut, suivie de ar et en", () => {
    expect(LOCALES).toEqual(["fr", "ar", "en"]);
    expect(DOMAIN_DEFAULT).toBe("fr");
    expect(DEFAULT_LOCALE).toBe("fr");
  });
});

describe("parseLocalePath", () => {
  it.each([
    ["/fr", { locale: "fr", rest: "" }],
    ["/fr/login", { locale: "fr", rest: "/login" }],
    ["/fr/dashboard///", { locale: "fr", rest: "/dashboard" }],
    ["/ar", { locale: "ar", rest: "" }],
    ["/ar/", { locale: "ar", rest: "" }],
    ["/en/login", { locale: "en", rest: "/login" }],
    ["/en/login/", { locale: "en", rest: "/login" }],
    ["/ar/dashboard///", { locale: "ar", rest: "/dashboard" }],
    ["/ar/leads/42", { locale: "ar", rest: "/leads/42" }],
  ])("%s -> %j", (path, expected) => {
    expect(parseLocalePath(path)).toEqual(expected);
  });

  it.each(["/", "", "/arx/login", "/a/login", "//ar/login", "/AR/login", "/Ar", "/FR/login", "/Fr", "/fra/login", "/frx", "/f", "/es/login", "fr/login", "//fr/login", "/ar./x", "/fr./x"])(
    "%s -> null (locale non reconnue)",
    (path) => {
      expect(parseLocalePath(path)).toBeNull();
    },
  );

  it("/ar//login : locale ar mais reste '//login', jamais une page publique", () => {
    const parsed = parseLocalePath("/ar//login");
    expect(parsed).toEqual({ locale: "ar", rest: "//login" });
    expect(isPublicPath(parsed!.rest)).toBe(false);
  });
});

describe("normalizePathname", () => {
  it("décode un segment encodé (même vue que le routeur Next.js)", () => {
    expect(normalizePathname("/%61r/dashboard")).toBe("/ar/dashboard");
    expect(normalizePathname("/%66r/dashboard")).toBe("/fr/dashboard");
    expect(normalizePathname("/%41R/dashboard")).toBe("/AR/dashboard");
    expect(normalizePathname("/ar/leads/a%20b")).toBe("/ar/leads/a b");
  });

  it("laisse intact un chemin déjà canonique", () => {
    expect(normalizePathname("/ar/dashboard")).toBe("/ar/dashboard");
    expect(normalizePathname("/ar/dashboard/")).toBe("/ar/dashboard/");
  });

  it.each([
    "/ar%2Fdashboard",
    "/ar%2fdashboard",
    "/ar%5Cdashboard",
    "/%2561r/dashboard",
    "/%252561r",
    "//ar/dashboard",
    "/ar//dashboard",
    "/ar/%2e%2e/dashboard",
    "/ar/%2E/x",
    "/ar/../x",
    "/ar/./x",
    "/ar\\dashboard",
    "/%ZZ",
    "/%c0%af",
    "/ar/%00",
    "/ar/%0d%0a",
    "ar/dashboard",
  ])("refuse %s", (path) => {
    expect(normalizePathname(path)).toBeNull();
  });
});

describe("pages publiques / invités", () => {
  it("n'accepte que les chemins exacts", () => {
    for (const p of ["", "/", "/login", "/signup", "/forgot-password", "/reset-password"]) {
      expect(isPublicPath(p)).toBe(true);
    }
    for (const p of ["/Login", "/login/x", "/login.", "/dashboard", "//login"]) {
      expect(isPublicPath(p)).toBe(false);
    }
    expect(isGuestOnlyPath("/login")).toBe(true);
    expect(isGuestOnlyPath("/forgot-password")).toBe(false);
  });
});
