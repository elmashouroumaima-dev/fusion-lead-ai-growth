import { afterEach, describe, expect, it } from "vitest";
import { captureLogs } from "./log-capture.testkit";
import { createLogger, redact, REDACTED, setLogSink } from "./logger";

afterEach(() => setLogSink(null));

/* Formes ajoutées (J12, durcissement final) : séparateurs libres, JSON dans une chaîne, userinfo, invitations encodées. */
describe("redact : paires nom/valeur, JSON, Basic, invitation, userinfo (tableau)", () => {
  const CASES: [string, string, string][] = [
    ["Basic minuscule", "authorization: basic dXNlcjpwYXNzd29yZDEyMw== sent", "dXNlcjpwYXNzd29yZDEyMw"],
    ["Basic majuscule", "BASIC dXNlcjpwYXNzd29yZDEyMw== sent", "dXNlcjpwYXNzd29yZDEyMw"],
    ["password: espace", "login password: hunter2hunter2 ok", "hunter2hunter2"],
    ["password = espaces", "password   =   hunter2hunter2 ok", "hunter2hunter2"],
    ["secret:", "secret:S3cr3tValue99 end", "S3cr3tValue99"],
    ["client_secret=", "client_secret=CS-value-12345&x=1", "CS-value-12345"],
    ["signature=", "?signature=SIGvalue123456&x=1", "SIGvalue123456"],
    ["x-api-key:", "x-api-key: KEYvalue123456 sent", "KEYvalue123456"],
    ["api-key=", "api-key=KEYvalue123456", "KEYvalue123456"],
    ["apikey:", "apikey: KEYvalue123456", "KEYvalue123456"],
    ["token encodé %3D", "cb?token%3DENCvalue12345%26x", "ENCvalue12345"],
    ["access_token encodé", "access_token%3DENCvalue12345", "ENCvalue12345"],
    ["code:", "code: OAUTHcode9876 end", "OAUTHcode9876"],
    ["token_hash:", "token_hash : HASHvalue12345", "HASHvalue12345"],
    ["JSON token", 'body {"token":"JSONvalue12345"} fin', "JSONvalue12345"],
    ["JSON password espaces", '{ "password" : "hunter2 hunter3" }', "hunter3"],
    ["JSON refresh_token", '{"refresh_token":"RTvalue12345","a":1}', "RTvalue12345"],
    ["JSON valeur nue", '{"secret":SECRETbare12345}', "SECRETbare12345"],
    ["JSON échappé", String.raw`{\"token\":\"ESCvalue12345\"}`, "ESCvalue12345"],
    ["invite majuscules", "GET /INVITE/AbCdEf0123456789_-XyZ", "AbCdEf0123456789_-XyZ"],
    ["invite encodé", "next=%2Finvite%2FAbCdEf0123456789_-XyZ", "AbCdEf0123456789_-XyZ"],
    ["invite encodé minuscule", "next=%2finvite%2fAbCdEf0123456789_-XyZ", "AbCdEf0123456789_-XyZ"],
    ["userinfo https", "fetch https://bob:pw-S3cret@host.test/x", "pw-S3cret"],
    ["userinfo ftp", "ftp://anna:pw-S3cret@files.test", "pw-S3cret"],
    ["userinfo sans mot de passe", "git clone https://ghp_TOKENvalue123@github.test/r", "ghp_TOKENvalue123"],
    ["userinfo avec @ dans le mot de passe", "postgres://u:p@ssWORD99@db.test/app", "ssWORD99"],
  ];

  it.each(CASES)("%s", (_name, input, secret) => {
    const out = redact({ note: input }) as { note: string };
    expect(out.note).not.toContain(secret);
    expect(out.note).toContain("[redacted]");
  });

  it("garde le nom du paramètre et le reste de la ligne", () => {
    const n = (v: string) => (redact({ n: v }) as { n: string }).n;
    expect(n("password: hunter2 ok")).toBe("password: [redacted] ok");
    expect(n("token%3DABC123&b=2")).toBe("token%3D[redacted]&b=2");
    expect(n('{"token":"V v","a":1}')).toBe('{"token":"[redacted]","a":1}');
    expect(n("authorization: basic dXNlcjpwYXNz")).toBe("authorization: Basic [redacted]");
    expect(n("go /INVITE/AbCdEf0123456789_-XyZ now")).toBe("go /invite/[redacted] now");
    expect(n("https://h.test/p?a=b@c")).toBe("https://h.test/p?a=b@c");
  });
});

/* Clés d'objet : masquées par valeur, bornées ; objets « comme des erreurs » ; séparateurs de ligne Unicode. */
describe("logger : noms de clés, erreurs simples, U+2028/2029", () => {
  it("une clé de 1 Mo ne produit pas de ligne de 1 Mo (clé bornée à 100 caractères)", () => {
    const big = "k".repeat(1024 * 1024);
    const out = redact({ [big]: 1 }) as Record<string, unknown>;
    expect(Object.keys(out)[0]?.length).toBeLessThanOrEqual(100);
    const cap = captureLogs();
    createLogger().info("e", { [big]: 1 });
    expect((cap.lines()[0] ?? "").length).toBeLessThan(500);
  });

  it.each([
    ["Bearer SECRETvalue12345", "SECRETvalue12345"],
    ["token=SECRETvalue12345", "SECRETvalue12345"],
    ["https://u:SECRETvalue12345@h.test", "SECRETvalue12345"],
    ["who@example.test", "who@example.test"],
  ])("la clé %s n'imprime pas le secret", (key, secret) => {
    const cap = captureLogs();
    createLogger().info("e", { [key]: "valeur" });
    expect(cap.lines()[0]).not.toContain(secret);
    expect(JSON.stringify(redact({ [key]: { n: 1 } }))).not.toContain(secret);
  });

  it("une clé sensible garde sa valeur masquée", () => {
    expect(redact({ password: "x" })).toEqual({ password: REDACTED });
  });

  it("erreur PostgREST simple : seulement name/code (jamais message, details, hint)", () => {
    const pg = { message: "duplicate key value violates unique constraint", details: "Key (email)=(a@b.test)", hint: "SELECTSECRET", code: "23505" };
    const out = redact({ error: pg });
    expect(out).toEqual({ error: { name: "Error", code: "23505" } });
    const text = JSON.stringify(out);
    for (const leak of ["duplicate", "Key (", "SELECTSECRET", "a@b.test"]) expect(text).not.toContain(leak);
  });

  it("erreur simple à prototype nul avec name", () => {
    const e = Object.assign(Object.create(null) as Record<string, unknown>, { message: "boom token=abc", name: "FetchError", extra: "E1" });
    const out = redact(e);
    expect(out).toEqual({ name: "FetchError" });
    expect(JSON.stringify(out)).not.toContain("boom");
  });

  it("un objet avec seulement message (sans name ni code) reste un objet ordinaire", () => {
    expect(redact({ message: "salut", n: 1 })).toEqual({ message: "salut", n: 1 });
  });

  it("U+2028 et U+2029 sont échappés dans la ligne sérialisée", () => {
    const cap = captureLogs();
    createLogger().info("e\u2028x", { note: "a\u2028b\u2029c", ["k\u2028"]: 1 });
    const line = cap.lines()[0] ?? "";
    expect(line).not.toContain("\u2028");
    expect(line).not.toContain("\u2029");
    expect(line).toContain(String.raw`\u2028`);
    expect(line).toContain(String.raw`\u2029`);
    expect(JSON.parse(line)).toMatchObject({ note: "a\u2028b\u2029c" });
  });
});
