import { describe, expect, it } from "vitest";
import { redact } from "./logger";

/** Entrées de 1 Mo visant les motifs ajoutés (paires, JSON, Basic, invitation, userinfo). */
function PATHOLOGICAL_NEW(mb: number): string[] {
  return [
    "password: ".repeat(mb / 10),
    "token%3D".repeat(mb / 8),
    '{"token":"'.repeat(mb / 10),
    `{"token":"${"a".repeat(mb)}`,
    `token${" ".repeat(mb)}`,
    "api_key ".repeat(mb / 8),
    "%2Finvite%2F".repeat(mb / 12),
    "/INVITE/".repeat(mb / 8),
    "x://".repeat(mb / 4),
    `://${"u".repeat(mb)}`,
    "basic ".repeat(mb / 6),
    `Basic ${"A".repeat(mb)}`,
    String.raw`\"token\":\"`.repeat(mb / 12),
    "code=".repeat(mb / 5),
  ];
}

/* Masquage par VALEUR (J12) : chaque forme de secret, noyée dans une chaîne plus longue sous une clé non sensible. */
describe("redact : valeurs secrètes dans une chaîne plus longue (clé non sensible)", () => {
  const CASES: [string, string, string][] = [
    ["query token", "GET /cb?foo=1&token=abcDEF123456&bar=2 done", "abcDEF123456"],
    ["query token_hash", "https://x.test/a?token_hash=h4sh-Valu3_xyz", "h4sh-Valu3_xyz"],
    ["query access_token", "redirect /x#a?access_token=ACCESSsecret99&z=1", "ACCESSsecret99"],
    ["query refresh_token", "refresh_token=REFRESHsecret99 trailing", "REFRESHsecret99"],
    ["query code", "callback ?code=oauthcode123456&state=s", "oauthcode123456"],
    ["query apikey", "call https://api.test/v1?apikey=KEY1234567890", "KEY1234567890"],
    ["query api_key", "call https://api.test/v1?api_key=KEY0987654321&x=1", "KEY0987654321"],
    ["invite path", "visited /invite/AbCdEf0123456789_-XyZ/accept now", "AbCdEf0123456789_-XyZ"],
    ["basic auth", "header Basic dXNlcjpwYXNzd29yZDEyMw== sent", "dXNlcjpwYXNzd29yZDEyMw"],
    ["connection string", "connect postgres://admin:S3cretPw!@db.internal:5432/app failed", "S3cretPw!"],
    ["connection string redis", "redis://default:pa55w0rd@cache.local", "pa55w0rd"],
  ];

  it.each(CASES)("%s est masqué dans une chaîne plus longue", (_name, input, secret) => {
    const out = redact({ note: input }) as { note: string };
    expect(out.note).not.toContain(secret);
    expect(out.note).toContain("[redacted]");
    expect(JSON.stringify(redact([input]))).not.toContain(secret);
  });

  it("conserve le reste de la chaîne et les paramètres non sensibles", () => {
    expect((redact({ n: "a=1&token=zzz999&b=2" }) as { n: string }).n).toBe("a=1&token=[redacted]&b=2");
    expect((redact({ n: "see /invite/short for help" }) as { n: string }).n).toBe("see /invite/short for help");
    expect((redact({ n: "http://host:8080/path" }) as { n: string }).n).toBe("http://host:8080/path");
  });

  it("le masquage ne lève pas et ne se bloque pas sur 1 Mo (motifs pathologiques)", () => {
    const MB = 1024 * 1024;
    const inputs = [
      "a".repeat(MB),
      "token=".repeat(MB / 6),
      "://u:".repeat(MB / 5),
      "Basic ".repeat(MB / 6),
      "/invite/".repeat(MB / 8),
      "a.".repeat(MB / 2),
      `${"x".repeat(MB / 2)}@${"y".repeat(MB / 2)}`,
      ...PATHOLOGICAL_NEW(MB),
    ];
    for (const input of inputs) {
      const start = Date.now();
      const out = redact({ v: input }) as { v: unknown };
      expect(typeof out.v).toBe("string");
      expect(Date.now() - start, input.slice(0, 24)).toBeLessThan(2000); // budget de 2 s PAR entrée
    }
  });
});
