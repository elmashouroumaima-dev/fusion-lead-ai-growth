import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getServerEnv, resetServerEnvCacheForTests } from "./server";

const KEYS = ["APP_ENV", "SUPABASE_URL", "SUPABASE_SECRET_KEY"] as const;

describe("getServerEnv", () => {
  beforeEach(() => {
    resetServerEnvCacheForTests();
    for (const key of KEYS) vi.stubEnv(key, undefined as unknown as string);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetServerEnvCacheForTests();
  });

  // J5 : l'app refuse de démarrer si une variable manque
  it("refuse de démarrer si une variable obligatoire manque, en nommant les variables", () => {
    expect(() => getServerEnv()).toThrowError(/SUPABASE_URL : manquante/);
    expect(() => getServerEnv()).toThrowError(/SUPABASE_SECRET_KEY : manquante/);
    expect(() => getServerEnv()).toThrowError(/APP_ENV : manquante/);
  });

  it("retourne l'environnement validé quand tout est présent", () => {
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_0123456789abcdefghij");
    expect(getServerEnv().APP_ENV).toBe("test");
  });

  // spec §6 / invariant 7 : le secret n'est jamais lisible côté navigateur
  it("est interdit dans le navigateur", () => {
    vi.stubGlobal("window", {});
    expect(() => getServerEnv()).toThrowError(/interdit dans le navigateur/);
  });
});
