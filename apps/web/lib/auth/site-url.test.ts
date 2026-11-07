import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetServerEnvCacheForTests } from "../env/server";
import { getSiteUrl } from "./site-url";

function baseEnv(appEnv: string): void {
  vi.stubEnv("APP_ENV", appEnv);
  vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_0123456789abcdefghij");
}

beforeEach(() => {
  resetServerEnvCacheForTests();
  vi.stubEnv("SITE_URL", undefined as unknown as string);
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetServerEnvCacheForTests();
});

describe("getSiteUrl", () => {
  it("développement sans SITE_URL -> repli http://127.0.0.1:3000", () => {
    baseEnv("development");
    expect(getSiteUrl()).toBe("http://127.0.0.1:3000");
  });

  it("SITE_URL vide en développement = absente (repli)", () => {
    baseEnv("development");
    vi.stubEnv("SITE_URL", "");
    expect(getSiteUrl()).toBe("http://127.0.0.1:3000");
  });

  it("retourne l'origine seule (chemin, query et slash final retirés)", () => {
    baseEnv("production");
    vi.stubEnv("SITE_URL", "https://app.example.test/some/path/?x=1");
    expect(getSiteUrl()).toBe("https://app.example.test");
  });

  it("staging sans SITE_URL -> erreur (jamais de repli localhost)", () => {
    baseEnv("staging");
    expect(() => getSiteUrl()).toThrowError(/SITE_URL/);
  });

  it("production avec SITE_URL en http -> erreur", () => {
    baseEnv("production");
    vi.stubEnv("SITE_URL", "http://app.example.test");
    expect(() => getSiteUrl()).toThrowError(/SITE_URL/);
  });

  it("SITE_URL invalide -> erreur nommant la variable sans afficher sa valeur", () => {
    baseEnv("development");
    vi.stubEnv("SITE_URL", "javascript:alert(1)");
    expect(() => getSiteUrl()).toThrowError(/SITE_URL : invalide/);
    expect(() => getSiteUrl()).not.toThrowError(/alert/);
  });
});
