import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { redact, REDACTED } from "./logger";

/*
 * Parité d'expurgation SQL <-> TypeScript (J12). private.audit_redact_value (migration) supprime les clés
 * dont le nom correspond à une liste de motifs ; le journal TypeScript doit en expurger AU MOINS autant.
 * Ce test lit la migration, extrait la liste de motifs et vérifie que chaque motif est couvert par `redact` :
 * si le SQL gagne un motif sans que le TS suive, le test échoue (dérive détectée).
 */
const MIGRATION = resolve(__dirname, "../../../../supabase/migrations/20261113100000_audit_logs.sql");

function sqlPatterns(): string[] {
  const sql = readFileSync(MIGRATION, "utf8");
  const start = sql.indexOf("create function private.audit_redact(");
  if (start < 0) throw new Error("private.audit_redact introuvable dans la migration");
  // Le motif est une constante de private.audit_redact : v_pattern constant text := '...';
  const match = /v_pattern\s+constant\s+text\s*:=\s*'([^']+)'/.exec(sql.slice(start));
  if (!match?.[1]) throw new Error("motif de clés (v_pattern) introuvable dans audit_redact");
  return match[1].replace(/^\(|\)$/g, "").split("|");
}

const API_KEY_PATTERN = "api[ ._-]?key";
const PRIVATE_KEY_PATTERN = "private[ ._-]?key";

/** Clés d'exemple par motif SQL (des clés réalistes qui doivent correspondre au motif). */
function samples(pattern: string): string[] {
  if (pattern === API_KEY_PATTERN) {
    return ["apikey", "api_key", "api-key", "x-api-key", "X-Api-Key", "x-api-key-id", "X-Api-Key-Id", "myApiKey", "API.KEY", "api key", "Api Key"];
  }
  if (pattern === PRIVATE_KEY_PATTERN) return ["private_key", "privateKey", "private-key", "private.key", "private key", "PRIVATE_KEY", "tls_private_key"];
  return [pattern, pattern.toUpperCase(), `x_${pattern}_y`, `prefix-${pattern}`];
}

const PATTERNS = sqlPatterns();

describe("parité d'expurgation SQL/TS", () => {
  it("la liste SQL extraite contient les 13 motifs attendus", () => {
    expect(PATTERNS).toEqual(
      expect.arrayContaining([
        "token", "secret", "password", "passwd", "hash", API_KEY_PATTERN, "authorization", "cookie", "credential", "jwt",
        PRIVATE_KEY_PATTERN, "signature", "otp",
      ]),
    );
  });

  it.each(PATTERNS)("le motif SQL %s est couvert par redact (TS)", (pattern) => {
    // Un motif avec méta-caractères autre que api/private key n'a pas d'exemples : le test échoue pour forcer son ajout.
    expect(/^[a-z]+$/.test(pattern) || pattern === API_KEY_PATTERN || pattern === PRIVATE_KEY_PATTERN, `motif sans clés d'exemple : ${pattern}`).toBe(true);
    for (const key of samples(pattern)) {
      expect(redact({ [key]: "valeur-sensible-12345" }), `clé ${key}`).toEqual({ [key]: REDACTED });
    }
  });
});
