import { EnvValidationError } from "@fusion-leap/domain";
import { describe, expect, it } from "vitest";
import { loadWorkerEnv } from "./env";

describe("loadWorkerEnv", () => {
  it("refuse de démarrer sans la clé secrète Supabase", () => {
    expect(() =>
      loadWorkerEnv({ APP_ENV: "test", SUPABASE_URL: "http://127.0.0.1:54321" }),
    ).toThrow(EnvValidationError);
  });

  it("accepte un environnement complet", () => {
    const env = loadWorkerEnv({
      APP_ENV: "test",
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SECRET_KEY: "sb_secret_0123456789abcdefghij",
    });
    expect(env.SUPABASE_SECRET_KEY).toContain("sb_secret_");
  });
});
