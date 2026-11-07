import { afterEach, describe, expect, it, vi } from "vitest";
import { captureLogs } from "./log-capture.testkit";
import { createLogger, logger, redact, REDACTED, setLogSink } from "./logger";
import { runWithRequestContext } from "./request-context";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl";

afterEach(() => {
  setLogSink(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("redact : clés sensibles (par nom, insensible à la casse, imbriquées)", () => {
  const KEYS = [
    "token", "access_token", "secret", "client_secret", "password", "passwd", "token_hash", "hash", "api_key", "apiKey", "apikey",
    "authorization", "Authorization", "x-api-key", "X-Api-Key", "x-api-key-id", "X-Api-Key-Id", "cookie", "set-cookie", "credential", "credentials", "jwt", "email", "e-mail", "invitee_email",
    "body", "message_body", "invite_path", "invitePath",
    "API.KEY", "api key", "private_key", "privateKey", "Private-Key", "signature", "x-hub-signature-256", "otp", "OTP", "totp",
  ];

  it.each(KEYS)("la valeur de la clé %s est remplacée", (key) => {
    expect(redact({ [key]: "valeur-sensible-12345" })).toEqual({ [key]: REDACTED });
  });

  it.each(KEYS)("la clé %s est aussi expurgée en profondeur et dans les tableaux", (key) => {
    expect(redact({ a: { b: [{ [key]: "x1234567", keep: 1 }] } })).toEqual({ a: { b: [{ [key]: REDACTED, keep: 1 }] } });
  });

  it("conserve les clés ordinaires", () => {
    expect(redact({ code: "rate_limited", name: "orgs.create", count: 3, ok: true, none: null })).toEqual({
      code: "rate_limited",
      name: "orgs.create",
      count: 3,
      ok: true,
      none: null,
    });
  });

  it("conserve pin, public_key, sign, api (non sensibles par nom)", () => {
    expect(redact({ pin: 1, public_key: "pk", sign: "s", api: "a" })).toEqual({ pin: 1, public_key: "pk", sign: "s", api: "a" });
  });

  it("expurge même une valeur non-chaîne sous une clé sensible (objet, nombre)", () => {
    expect(redact({ password: { nested: "a" }, token: 42 })).toEqual({ password: REDACTED, token: REDACTED });
  });
});

describe("redact : valeurs sensibles (par contenu)", () => {
  it.each([
    ["JWT", `jeton ${JWT} fin`, "jeton [redacted] fin"],
    ["Bearer", "Authorization: Bearer abc.DEF-123_xyz== ok", "Authorization: [redacted] ok"],
    ["bearer minuscule", "bearer abcdef123456", "[redacted]"],
    ["sb_secret_", "clé sb_secret_AbC123_xyz-9 ok", "clé [redacted] ok"],
    ["sb_publishable_", "clé sb_publishable_AbC123 ok", "clé [redacted] ok"],
    ["e-mail", "contact jean.dupont+x@example.co.uk merci", "contact [redacted] merci"],
    ["deux e-mails", "a@b.com et c@d.org", "[redacted] et [redacted]"],
  ])("%s dans une chaîne", (_label, input, expected) => {
    expect(redact({ note: input })).toEqual({ note: expected });
  });

  it("dans un tableau de chaînes", () => {
    expect(redact({ list: [JWT, "ok", "x@y.com"] })).toEqual({ list: [REDACTED, "ok", REDACTED] });
  });

  it("laisse les chaînes inoffensives intactes (uuid, code SQL)", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(redact({ id, db: "23505" })).toEqual({ id, db: "23505" });
  });
});

describe("redact : erreurs, cycles, tailles", () => {
  it("sérialise une Error en { name, code? } SEULEMENT (ni message ni pile)", () => {
    const err = Object.assign(new Error("token=abc SELECT * FROM users where email='a@b.com'"), { code: "23505" });
    const out = redact({ err });
    expect(out).toEqual({ err: { name: "Error", code: "23505" } });
    expect(JSON.stringify(out)).not.toContain("abc");
    expect(JSON.stringify(out)).not.toContain("SELECT");
  });

  it("une sous-classe d'Error garde son nom, sans code", () => {
    class BoomError extends Error {
      override name = "BoomError";
    }
    expect(redact(new BoomError("secret"))).toEqual({ name: "BoomError" });
  });

  it("un code d'erreur est lui aussi masqué par valeur", () => {
    const out = redact(Object.assign(new Error("x"), { code: JWT })) as { code: string };
    expect(out.code).toBe(REDACTED);
  });

  it("références circulaires : '[circular]', sans lever", () => {
    const a: Record<string, unknown> = { id: 1 };
    a.self = a;
    a.list = [a];
    expect(redact(a)).toEqual({ id: 1, self: "[circular]", list: ["[circular]"] });
  });

  it("une même référence répétée (non circulaire) n'est pas confondue avec un cycle", () => {
    const shared = { v: 1 };
    expect(redact({ a: shared, b: shared })).toEqual({ a: { v: 1 }, b: { v: 1 } });
  });

  it("profondeur plafonnée", () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 20; i += 1) deep = { child: deep };
    expect(JSON.stringify(redact(deep))).toContain("[max-depth]");
  });

  it("entrée énorme : tableau, clés, chaîne et nombre de noeuds plafonnés", () => {
    const big = {
      arr: Array.from({ length: 100000 }, (_, i) => i),
      keys: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, i])),
      str: "a".repeat(5_000_000),
      nodes: Array.from({ length: 49 }, () => Array.from({ length: 49 }, () => ({ x: {} }))),
    };
    const started = Date.now();
    const out = redact(big) as { arr: unknown[]; keys: Record<string, unknown>; str: string };
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out.arr).toHaveLength(51);
    expect(out.arr[50]).toBe("[+99950 more]");
    expect(Object.keys(out.keys)).toHaveLength(51);
    expect(out.str.length).toBeLessThanOrEqual(501);
    expect(JSON.stringify(out)).toContain("[truncated]");
    expect(JSON.stringify(out).length).toBeLessThan(100_000);
  });

  it("une chaîne pathologique pour les expressions régulières reste rapide", () => {
    const started = Date.now();
    redact({ s: "a.".repeat(100000) });
    redact({ s: "a".repeat(100000) });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("un secret coupé par le plafond n'est jamais exposé en entier", () => {
    const out = redact({ s: `${"x".repeat(450)}${JWT}${"y".repeat(5000)}` }) as { s: string };
    expect(out.s).not.toContain("eyJhbGci");
  });

  it("ne lève jamais : accesseur qui lève, Proxy hostile, bigint, symbole, fonction, Date invalide", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("boom");
        },
        get: () => {
          throw new Error("boom");
        },
      },
    );
    const getter = {
      get bad(): string {
        throw new Error("boom");
      },
      ok: 1,
    };
    expect(() => redact(hostile)).not.toThrow();
    expect(redact(getter)).toEqual({ bad: REDACTED, ok: 1 });
    expect(redact({ b: 10n, s: Symbol("x"), f: () => 1, d: new Date(Number.NaN), n: Number.NaN })).toEqual({
      b: "10",
      s: "[symbol]",
      f: "[function]",
      d: "[invalid-date]",
      n: "NaN",
    });
  });
});

describe("logger : forme de la ligne", () => {
  it("une ligne JSON { ts, level, event, ...champs }, niveaux corrects, une seule ligne", () => {
    const cap = captureLogs();
    const log = createLogger();
    log.debug("e.debug");
    log.info("e.info", { a: 1 });
    log.warn("e.warn");
    log.error("e.error", { code: "x" });
    expect(cap.logs.map((l) => l.level)).toEqual(["debug", "info", "warn", "error"]);
    const parsed = cap.parsed();
    expect(Object.keys(parsed[1] ?? {})).toEqual(["ts", "level", "event", "a"]);
    expect(parsed[1]).toMatchObject({ level: "info", event: "e.info", a: 1 });
    expect(new Date(String(parsed[1]?.ts)).toISOString()).toBe(parsed[1]?.ts);
    expect(parsed[3]).toMatchObject({ level: "error", event: "e.error", code: "x" });
    for (const l of cap.logs) expect(l.line).not.toContain("\n");
  });

  it("ajoute request_id, organization_id et actor_id du contexte de requête (dans cet ordre, après event)", () => {
    const cap = captureLogs();
    runWithRequestContext({ requestId: "rid-1", organizationId: "org-1", actorId: "act-1" }, () => logger.info("ctx.event", { x: 1 }));
    expect(Object.keys(cap.parsed()[0] ?? {})).toEqual(["ts", "level", "event", "request_id", "organization_id", "actor_id", "x"]);
    expect(cap.parsed()[0]).toMatchObject({ request_id: "rid-1", organization_id: "org-1", actor_id: "act-1" });
  });

  it("sans contexte : aucun champ de contexte ; request_id de l'appelant n'est jamais posé tel quel", () => {
    const cap = captureLogs();
    logger.info("no.ctx");
    logger.info("no.ctx.spoof", { request_id: "spoofed-id" });
    expect(cap.parsed()[0]).not.toHaveProperty("request_id");
    expect(cap.parsed()[1]).not.toHaveProperty("request_id");
    expect(cap.parsed()[1]).toMatchObject({ client_request_id: "spoofed-id" });
  });

  it("le contexte de requête l'EMPORTE sur request_id/organization_id/actor_id de l'appelant (tentative d'usurpation)", () => {
    const cap = captureLogs();
    runWithRequestContext({ requestId: "server-rid", organizationId: "org-real", actorId: "actor-real" }, () => {
      logger.info("spoof.fields", { request_id: "forged-rid", organization_id: "org-forged", actor_id: "actor-forged", x: 1 });
      createLogger({ base: { request_id: "forged-base", actor_id: "actor-forged-base" } }).info("spoof.base");
    });
    const [fields, base] = cap.parsed();
    expect(fields).toMatchObject({ request_id: "server-rid", organization_id: "org-real", actor_id: "actor-real", x: 1 });
    expect(fields).toMatchObject({ client_request_id: "forged-rid", client_organization_id: "org-forged", client_actor_id: "actor-forged" });
    expect(base).toMatchObject({ request_id: "server-rid", organization_id: "org-real", actor_id: "actor-real" });
    expect(base).toMatchObject({ client_request_id: "forged-base", client_actor_id: "actor-forged-base" });
  });

  it("une valeur null/undefined de l'appelant ne remplace jamais le contexte et ne crée aucun champ client_*", () => {
    const cap = captureLogs();
    runWithRequestContext({ requestId: "server-rid", actorId: "actor-real" }, () =>
      logger.info("nulls", { request_id: null, actor_id: undefined, organization_id: null }),
    );
    const line = cap.parsed()[0] ?? {};
    expect(line).toMatchObject({ request_id: "server-rid", actor_id: "actor-real" });
    expect(Object.keys(line).some((k) => k.startsWith("client_"))).toBe(false);
    expect(line).not.toHaveProperty("organization_id");
  });

  it("un client_request_id explicite n'est pas écrasé par la valeur déplacée", () => {
    const cap = captureLogs();
    runWithRequestContext({ requestId: "server-rid" }, () => logger.info("explicit.client", { request_id: "moved", client_request_id: "explicit-client" }));
    expect(cap.parsed()[0]).toMatchObject({ request_id: "server-rid", client_request_id: "explicit-client" });
  });

  it("base fusionnée, champs expurgés ; ts/level/event ne sont jamais écrasés", () => {
    const cap = captureLogs();
    createLogger({ base: { service: "web", token: "abc" } }).info("real.event", {
      ts: "forged",
      level: "debug",
      event: "forged",
      email: "a@b.com",
      id: "u1",
    });
    const line = cap.parsed()[0] ?? {};
    expect(line).toMatchObject({ level: "info", event: "real.event", service: "web", token: REDACTED, email: REDACTED, id: "u1" });
    expect(line.ts).not.toBe("forged");
  });

  it("le nom d'événement lui-même est masqué et borné", () => {
    const cap = captureLogs();
    logger.info(`oops ${JWT} ${"z".repeat(500)}`);
    const event = String(cap.parsed()[0]?.event);
    expect(event).not.toContain("eyJ");
    expect(event.length).toBeLessThanOrEqual(100);
  });

  it("ne lève jamais, même avec une valeur non sérialisable ou un récepteur qui lève", () => {
    const circular: Record<string, unknown> = {};
    circular.o = circular;
    expect(() => logger.info("big", { n: 10n, c: circular })).not.toThrow();
    setLogSink(() => {
      throw new Error("sink down");
    });
    expect(() => logger.error("sink.fail", { a: 1 })).not.toThrow();
  });
});

describe("logger : sortie par défaut", () => {
  it("silencieux sous NODE_ENV=test sans récepteur", () => {
    const spies = (["debug", "info", "warn", "error", "log"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("hors test : stdout pour debug/info, stderr pour warn/error, une ligne JSON chacun", () => {
    vi.stubEnv("NODE_ENV", "production");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logger.debug("d");
    logger.info("i");
    logger.warn("w", { token: "t" });
    logger.error("e");
    expect(debug).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({ level: "warn", event: "w", token: REDACTED });
  });
});
