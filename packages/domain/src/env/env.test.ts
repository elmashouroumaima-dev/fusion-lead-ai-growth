import { describe, expect, it } from "vitest";
import {
  EnvValidationError,
  findBundleLeaks,
  findPublicVariableLeaks,
  looksLikeSupabaseSecret,
  parseClientEnv,
  parseServerEnv,
} from "./index";

const validServer = {
  APP_ENV: "development",
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SECRET_KEY: "sb_secret_0123456789abcdefghij",
};

const validClient = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_0123456789abcdef",
};

/** JWT factice (signature non valide) portant le rôle indiqué. */
function fakeJwt(role: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role })}.signaturefactice123`;
}

// spec §6 : validation zod de l'environnement, séparation serveur / client
describe("parseServerEnv", () => {
  it("accepte un environnement valide et applique les valeurs par défaut", () => {
    const env = parseServerEnv(validServer);
    expect(env.APP_ENV).toBe("development");
    expect(env.AI_ALLOW_REAL_DATA).toBe(false); // ADR 012 : fermé par défaut
    expect(env.RESEND_API_KEY).toBeUndefined();
  });

  it("refuse une variable manquante et la nomme sans afficher de valeur", () => {
    const incomplete = Object.fromEntries(
      Object.entries(validServer).filter(([key]) => key !== "SUPABASE_SECRET_KEY"),
    );
    expect.assertions(4);
    try {
      parseServerEnv(incomplete);
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const e = error as EnvValidationError;
      expect(e.variables).toEqual(["SUPABASE_SECRET_KEY"]);
      expect(e.message).toContain("SUPABASE_SECRET_KEY : manquante");
      expect(e.message).not.toContain("sb_secret_");
    }
  });

  it("n'écrit jamais la valeur d'une variable invalide dans le message", () => {
    const secret = "valeur-qui-ne-doit-pas-fuiter-123456";
    expect.assertions(2);
    try {
      parseServerEnv({ ...validServer, SUPABASE_URL: secret });
    } catch (error) {
      expect((error as Error).message).toContain("SUPABASE_URL : invalide");
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it("refuse une valeur hors énumération pour APP_ENV", () => {
    expect(() => parseServerEnv({ ...validServer, APP_ENV: "prod" })).toThrow(EnvValidationError);
  });

  it("refuse une clé Resend qui n'a pas le bon préfixe", () => {
    expect(() => parseServerEnv({ ...validServer, RESEND_API_KEY: "abc" })).toThrow(
      EnvValidationError,
    );
  });

  it("traite une chaîne vide comme manquante", () => {
    expect(() => parseServerEnv({ ...validServer, SUPABASE_SECRET_KEY: "" })).toThrow(
      EnvValidationError,
    );
  });
});

describe("parseClientEnv", () => {
  it("accepte un environnement valide", () => {
    expect(parseClientEnv(validClient).NEXT_PUBLIC_SUPABASE_URL).toBe("http://127.0.0.1:54321");
  });

  it("refuse une variable manquante", () => {
    expect(() => parseClientEnv({})).toThrow(EnvValidationError);
  });

  it("ne laisse pas passer de secret serveur : le schéma client ne les connaît pas", () => {
    const parsed = parseClientEnv({
      ...validClient,
      SUPABASE_SECRET_KEY: validServer.SUPABASE_SECRET_KEY,
    });
    expect(Object.keys(parsed)).not.toContain("SUPABASE_SECRET_KEY");
  });
});

// spec §6 / invariant 7 : service_role jamais dans une variable NEXT_PUBLIC_*
describe("findPublicVariableLeaks", () => {
  it("ne signale rien pour la configuration publique normale", () => {
    expect(findPublicVariableLeaks(validClient)).toEqual([]);
  });

  it("signale un nom de variable publique désignant un secret", () => {
    const f = findPublicVariableLeaks({ NEXT_PUBLIC_SERVICE_ROLE_KEY: "x" });
    expect(f.map((x) => x.kind)).toEqual(["public-variable-name"]);
  });

  it("signale une clé sb_secret_ placée dans une variable publique, quel que soit son nom", () => {
    const f = findPublicVariableLeaks({ NEXT_PUBLIC_FOO: "sb_secret_0123456789abcdef" });
    expect(f.map((x) => x.kind)).toEqual(["public-variable-value"]);
  });

  it("signale un JWT service_role placé dans une variable publique", () => {
    const f = findPublicVariableLeaks({ NEXT_PUBLIC_FOO: fakeJwt("service_role") });
    expect(f.map((x) => x.kind)).toEqual(["public-variable-value"]);
  });

  it("n'accuse pas un JWT de rôle anon", () => {
    expect(findPublicVariableLeaks({ NEXT_PUBLIC_FOO: fakeJwt("anon") })).toEqual([]);
  });

  it("ignore les variables non publiques", () => {
    expect(findPublicVariableLeaks({ SUPABASE_SECRET_KEY: "sb_secret_0123456789abcdef" })).toEqual(
      [],
    );
  });

  it("ne reprend jamais la valeur dans le constat", () => {
    const f = findPublicVariableLeaks({ NEXT_PUBLIC_FOO: "sb_secret_0123456789abcdef" });
    expect(JSON.stringify(f)).not.toContain("0123456789abcdef");
  });
});

describe("findBundleLeaks", () => {
  it("détecte la valeur exacte d'un secret serveur dans un fichier du bundle", () => {
    const f = findBundleLeaks("static/chunks/a.js", `var k="${validServer.SUPABASE_SECRET_KEY}";`, [
      validServer.SUPABASE_SECRET_KEY,
    ]);
    expect(f.length).toBeGreaterThan(0);
    expect(JSON.stringify(f)).not.toContain(validServer.SUPABASE_SECRET_KEY);
  });

  it("détecte un JWT service_role même si sa valeur n'est pas connue", () => {
    const f = findBundleLeaks("static/chunks/a.js", `x="${fakeJwt("service_role")}"`);
    expect(f).toHaveLength(1);
  });

  it("ne signale pas un JWT anon ni un bundle propre", () => {
    expect(findBundleLeaks("a.js", `x="${fakeJwt("anon")}"`)).toEqual([]);
    expect(findBundleLeaks("a.js", "console.log('ok')", [validServer.SUPABASE_SECRET_KEY])).toEqual(
      [],
    );
  });

  it("ignore les valeurs de secret trop courtes pour être significatives", () => {
    expect(findBundleLeaks("a.js", "abc", ["abc"])).toEqual([]);
  });
});

describe("looksLikeSupabaseSecret", () => {
  it("reconnaît les deux formes de clé secrète", () => {
    expect(looksLikeSupabaseSecret("sb_secret_abcdefghij")).toBe(true);
    expect(looksLikeSupabaseSecret(fakeJwt("service_role"))).toBe(true);
    expect(looksLikeSupabaseSecret("sb_publishable_abcdefghij")).toBe(false);
  });
});
