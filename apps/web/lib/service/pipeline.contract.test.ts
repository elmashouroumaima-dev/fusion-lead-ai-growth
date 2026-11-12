import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests de contrat du pipeline J11 (agent A4), écrits indépendamment de with-service.test.ts :
 * un SEUL journal d'appels ordonné pour toutes les étapes, des tables exhaustives sur les codes,
 * des erreurs hostiles (chaînes, objets, SQL, secrets) et les bornes de la clé d'idempotence.
 */
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const KEY = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ATTEMPT = "11111111-2222-4333-8444-555555555555";
const SECRET = "sk_live_SUPERSECRET_hunter2";
const SQL = `select * from public.members where email = 'victim@example.com' -- ${SECRET}`;

const log: string[] = [];
const getTenantContext = vi.fn();
const getClaims = vi.fn();
const takeToken = vi.fn();
const begin = vi.fn();
const complete = vi.fn();
const abandon = vi.fn();

vi.mock("../supabase/server", () => ({ createClient: async () => ({ auth: { getClaims } }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${url};307;` });
  },
}));
vi.mock("../tenant/context", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTenantContext: (...a: unknown[]) => getTenantContext(...a),
}));
vi.mock("./rate-limit", () => ({ LIMITS: {}, takeToken: (...a: unknown[]) => takeToken(...a) }));
vi.mock("./idempotency", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  idempotencyBegin: (...a: unknown[]) => begin(...a),
  idempotencyComplete: (...a: unknown[]) => complete(...a),
  idempotencyAbandon: (...a: unknown[]) => abandon(...a),
}));

import { TenantError } from "../tenant/tenant-error";
import { ServiceError, serviceErrorStatus, type ServiceErrorCode } from "./errors";
import { withAction, withRoute, type RouteResult, type ServiceSchema } from "./with-service";

const ALL_CODES: ServiceErrorCode[] = [
  "unauthenticated",
  "forbidden",
  "validation_failed",
  "not_found",
  "idempotency_conflict",
  "idempotency_in_progress",
  "duplicate_request",
  "rate_limited",
  "payload_too_large",
  "quota_exceeded",
  "conflict",
  "service_unavailable",
  "internal_error",
];
const STATUS: Record<ServiceErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  validation_failed: 400,
  not_found: 404,
  idempotency_conflict: 422,
  idempotency_in_progress: 409,
  duplicate_request: 409,
  rate_limited: 429,
  payload_too_large: 413,
  quota_exceeded: 429,
  conflict: 409,
  service_unavailable: 503,
  internal_error: 500,
};

type Body = { name: string };
const schema: ServiceSchema<Body> = {
  safeParse(raw) {
    const r = raw as Record<string, unknown> | null;
    if (r && typeof r === "object" && typeof r.name === "string") return { success: true, data: r as Body };
    return { success: false, error: { issues: [{ code: "invalid_type", path: ["name"] }] } };
  },
};

const tenant = (role = "company_owner") => ({
  userId: USER,
  organizationId: ORG,
  role,
  organization: { id: ORG, name: "Acme Secret Org", slug: "acme", locale: "fr", timezone: "UTC" },
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost:3000/api/x", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const handler = vi.fn();
let warn: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  log.length = 0;
  getTenantContext.mockImplementation(async () => (log.push("auth"), tenant()));
  getClaims.mockImplementation(async () => (log.push("auth"), { data: { claims: { sub: USER } }, error: null }));
  takeToken.mockImplementation(async () => (log.push("rate"), { allowed: true, retryAfterSeconds: 0 }));
  begin.mockImplementation(async () => (log.push("begin"), { state: "new", attemptId: ATTEMPT }));
  complete.mockImplementation(async () => void log.push("complete"));
  abandon.mockImplementation(async () => void log.push("abandon"));
  handler.mockImplementation(async (): Promise<RouteResult> => (log.push("handler"), { status: 201, body: { ok: 1 } }));
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  err = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

const route = (over: Record<string, unknown> = {}) =>
  withRoute(
    {
      name: "x.create",
      auth: "tenant",
      schema,
      permission: { action: "invite", resource: "members", ctx: () => ({ assignedRole: "analyst" }) },
      rateLimit: "sensitive",
      idempotency: { mode: "required", storeResponse: true },
      ...over,
    } as never,
    handler as never,
  );

const allLogged = () => [...warn.mock.calls, ...err.mock.calls].flat().join("\n");

describe("ordre exact des étapes (journal unique)", () => {
  it("chemin nominal : auth, rate, begin, handler, complete, chacun UNE fois", async () => {
    const res = await route()(post({ name: "a" }, { "idempotency-key": KEY }));
    expect(res.status).toBe(201);
    expect(log).toEqual(["auth", "rate", "begin", "handler", "complete"]);
  });

  it("permission refusée : ni débit consommé, ni begin, ni handler (le refus précède toute consommation)", async () => {
    getTenantContext.mockImplementation(async () => (log.push("auth"), tenant("analyst")));
    const res = await route()(post({ name: "a" }, { "idempotency-key": KEY }));
    expect(res.status).toBe(403);
    expect(log).toEqual(["auth"]);
    expect(takeToken).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("débit refusé : begin et handler jamais appelés ; débit AVANT idempotence", async () => {
    takeToken.mockImplementation(async () => (log.push("rate"), { allowed: false, retryAfterSeconds: 7 }));
    const res = await route()(post({ name: "a" }, { "idempotency-key": KEY }));
    expect(res.status).toBe(429);
    expect(log).toEqual(["auth", "rate"]);
  });

  it("clé d'idempotence invalide : begin et handler non appelés", async () => {
    const res = await route()(post({ name: "a" }, { "idempotency-key": "short" }));
    expect(res.status).toBe(400);
    expect(log).toEqual(["auth", "rate"]);
  });

  it("handler en échec inattendu : abandon APRÈS le handler, jamais complete", async () => {
    handler.mockImplementation(async () => {
      log.push("handler");
      throw new Error(SQL);
    });
    const res = await route()(post({ name: "a" }, { "idempotency-key": KEY }));
    expect(res.status).toBe(500);
    expect(log).toEqual(["auth", "rate", "begin", "handler", "abandon"]);
  });

  it.each([
    ["authentification", () => getTenantContext.mockRejectedValue(new TenantError("unauthenticated")), 401],
    ["tenant interdit", () => getTenantContext.mockRejectedValue(new TenantError("forbidden")), 403],
  ] as const)("échec à l'étape %s : aucune étape suivante", async (_n, setup, status) => {
    setup();
    const res = await route()(post({ name: "a" }, { "idempotency-key": KEY }));
    expect(res.status).toBe(status);
    expect([takeToken, begin, handler, complete, abandon].map((f) => f.mock.calls.length)).toEqual([0, 0, 0, 0, 0]);
  });

  it("le corps invalide est refusé avant TOUTE lecture d'authentification", async () => {
    for (const r of [post("{nope"), post({ nom: 1 }), post({ name: "a" }, { "content-length": "999999" })]) {
      await route()(r);
    }
    expect(getTenantContext).not.toHaveBeenCalled();
    expect(getClaims).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  it("l'authentification 'tenant' relit le contexte à CHAQUE requête (aucun cache)", async () => {
    const r = route({ idempotency: "none" });
    await r(post({ name: "a" }));
    await r(post({ name: "b" }));
    expect(getTenantContext).toHaveBeenCalledTimes(2);
  });

  it("un rôle révoqué entre deux requêtes est pris en compte immédiatement", async () => {
    const r = route({ idempotency: "none" });
    expect((await r(post({ name: "a" }))).status).toBe(201);
    getTenantContext.mockRejectedValue(new TenantError("forbidden"));
    expect((await r(post({ name: "a" }))).status).toBe(403);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("table exhaustive des codes : statut, corps, en-têtes", () => {
  it("la table de test couvre exactement les codes (statuts alignés sur serviceErrorStatus)", () => {
    expect(ALL_CODES.map((c) => serviceErrorStatus(c))).toEqual(ALL_CODES.map((c) => STATUS[c]));
    expect(new ServiceError("rate_limited").status).toBe(429);
  });

  it.each(ALL_CODES)("handler lève ServiceError(%s) -> statut de la table, corps normalisé, abandon", async (code) => {
    handler.mockRejectedValue(new ServiceError(code, { retryAfterSeconds: 3 }));
    const res = await route()(post({ name: "a" }, { "idempotency-key": KEY, "x-request-id": "req-12345678" }));
    expect(res.status).toBe(STATUS[code]);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["code", "message", "request_id"]);
    expect(body.code).toBe(code);
    expect(typeof body.message).toBe("string");
    expect((body.message as string).length).toBeGreaterThan(5);
    expect(body.request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(body.request_id).not.toBe("req-12345678"); // jamais le x-request-id du client
    expect(res.headers.get("x-request-id")).toBe(body.request_id);
    expect(abandon).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it.each(ALL_CODES)("message générique pour %s : aucun texte d'infrastructure", async (code) => {
    handler.mockRejectedValue(new ServiceError(code));
    const res = await route()(post({ name: "a" }, { "idempotency-key": KEY }));
    const { message } = (await res.json()) as { message: string };
    expect(message).not.toMatch(/postgres|supabase|select |sql|stack|\.ts/i);
  });

  it("Retry-After n'apparaît que pour les erreurs qui le portent, en entier positif", async () => {
    handler.mockRejectedValue(new ServiceError("rate_limited", { retryAfterSeconds: 12 }));
    const a = await route()(post({ name: "a" }, { "idempotency-key": KEY }));
    expect(a.headers.get("retry-after")).toBe("12");
    handler.mockRejectedValue(new ServiceError("forbidden"));
    const b = await route()(post({ name: "a" }, { "idempotency-key": KEY }));
    expect(b.headers.get("retry-after")).toBeNull();
  });
});

describe("valeurs levées hostiles -> internal_error générique, aucune fuite", () => {
  const hostile: Array<[string, unknown]> = [
    ["chaîne", SQL],
    ["Error avec SQL et secret", new Error(SQL)],
    ["TypeError", new TypeError(SECRET)],
    ["objet avec message", { message: SQL, code: "forbidden", status: 200 }],
    ["objet imitant ServiceError", { name: "ServiceError", code: "forbidden", status: 403, message: SECRET }],
    ["erreur Postgres brute", { code: "23505", message: SQL, details: SECRET, hint: SECRET }],
    ["null", null],
    ["undefined", undefined],
    ["nombre", 42],
    ["Error avec cause", new Error("x", { cause: new Error(SECRET) })],
    ["Error à la pile piégée", Object.assign(new Error("x"), { stack: SECRET })],
  ];

  it.each(hostile)("handler lève %s", async (_n, thrown) => {
    handler.mockImplementation(async () => {
      throw thrown;
    });
    const res = await route()(post({ name: "a" }, { "idempotency-key": KEY }));
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toMatchObject({ code: "internal_error" });
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("victim@example.com");
    expect(allLogged()).not.toContain("hunter2");
    expect(allLogged()).not.toContain("victim@example.com");
    expect(abandon).toHaveBeenCalledTimes(1);
  });

  it.each(hostile)("une panne de l'authentification (%s) ne fuit pas", async (_n, thrown) => {
    getTenantContext.mockImplementation(async () => {
      throw thrown;
    });
    const res = await route()(post({ name: "a" }, { "idempotency-key": KEY }));
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).not.toContain("hunter2");
    expect(allLogged()).not.toContain("hunter2");
    expect(handler).not.toHaveBeenCalled();
  });

  it("l'organisation, le corps et la clé ne sont jamais journalisés", async () => {
    handler.mockRejectedValue(new Error("boom"));
    await route()(post({ name: "Nom Très Privé" }, { "idempotency-key": KEY }));
    const out = allLogged();
    expect(out).not.toContain("Nom Très Privé");
    expect(out).not.toContain("Acme Secret Org");
    expect(out).not.toContain(KEY);
    expect(out).not.toMatch(/[0-9a-f]{64}/);
  });

  it("un x-request-id piégé n'est jamais écho (retour à un uuid)", async () => {
    const res = await route()(post({ name: "a" }, { "idempotency-key": KEY, "x-request-id": "bad id\twith space" }));
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("clé d'idempotence : bornes de longueur et de jeu de caractères", () => {
  it.each([
    [7, 400],
    [8, 201],
    [128, 201],
    [129, 400],
  ])("longueur %i -> %i", async (n, status) => {
    const res = await route()(post({ name: "a" }, { "idempotency-key": "k".repeat(n) }));
    expect(res.status).toBe(status);
    expect(begin).toHaveBeenCalledTimes(status === 201 ? 1 : 0);
    if (status !== 201) expect(handler).not.toHaveBeenCalled();
  });

  it.each(["abcd efgh", "abcd/efgh", "abcd.efgh", "abcd:efgh", "abcd;efgh", "abcd'efgh", "abcd=efgh"])(
    "caractère interdit dans %j -> 400, begin non appelé",
    async (k) => {
      const res = await route()(post({ name: "a" }, { "idempotency-key": k }));
      expect(res.status).toBe(400);
      expect(begin).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it.each(["abcd_efgh", "ABCD-efgh-1234", "0f8fad5b-d9cb-469f-a165-70867728950e"])("clé valide %j acceptée", async (k) => {
    expect((await route()(post({ name: "a" }, { "idempotency-key": k }))).status).toBe(201);
  });

  it("clé requise absente -> 400 validation_failed, handler jamais appelé", async () => {
    const res = await route()(post({ name: "a" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("validation_failed");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("machine d'états d'idempotence vue du pipeline", () => {
  const states: Array<[string, unknown, number, string]> = [
    ["conflict", { state: "conflict" }, 422, "idempotency_conflict"],
    ["in_progress", { state: "in_progress" }, 409, "idempotency_in_progress"],
  ];
  it.each(states)("%s -> %i %s, handler/complete/abandon non appelés", async (_s, decision, status, code) => {
    begin.mockResolvedValue(decision);
    const res = await route()(post({ name: "a" }, { "idempotency-key": KEY }));
    expect(res.status).toBe(status);
    expect(((await res.json()) as { code: string }).code).toBe(code);
    expect([handler, complete, abandon].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it("replay : réponse stockée rendue telle quelle + Idempotent-Replay, handler non appelé", async () => {
    begin.mockResolvedValue({ state: "replay", statusCode: 202, response: { body: { stored: true } } });
    const res = await route()(post({ name: "a" }, { "idempotency-key": KEY }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ stored: true });
    expect(res.headers.get("idempotent-replay")).toBe("true");
    expect(handler).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("replay avec storeResponse:false : 409 duplicate_request, aucun corps de l'effet initial", async () => {
    begin.mockResolvedValue({ state: "replay", statusCode: 201, response: { replayed: true } });
    const res = await route({ idempotency: { mode: "required", storeResponse: false } })(
      post({ name: "a" }, { "idempotency-key": KEY }),
    );
    const parsed = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(409);
    expect(parsed.code).toBe("duplicate_request");
    expect(Object.keys(parsed).sort()).toEqual(["code", "message", "request_id"]);
    expect(handler).not.toHaveBeenCalled();
  });

  it("storeResponse:false : complete reçoit EXACTEMENT { replayed: true }, jamais le corps du handler", async () => {
    handler.mockResolvedValue({ status: 201, body: { invite_url: `https://x/invite/${SECRET}` } });
    const r = route({ idempotency: { mode: "required", storeResponse: false } });
    const res = await r(post({ name: "a" }, { "idempotency-key": KEY }));
    expect(res.status).toBe(201);
    expect(complete).toHaveBeenCalledTimes(1);
    const arg = complete.mock.calls[0]![1] as { response: unknown };
    expect(arg.response).toEqual({ replayed: true });
    expect(JSON.stringify(complete.mock.calls)).not.toContain(SECRET);
  });

  it.each([500, 502, 503])("le handler répond %i -> abandon, pas de complete (la mutation peut être rejouée)", async (status) => {
    handler.mockResolvedValue({ status, body: { code: "x" } });
    await route()(post({ name: "a" }, { "idempotency-key": KEY }));
    expect(abandon).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it("begin reçoit la MÊME empreinte quelle que soit la mise en forme JSON (espaces, ordre des clés)", async () => {
    const r = route({ schema: { safeParse: (x: unknown) => ({ success: true, data: x }) } });
    await r(post('{"a":1,"b":[1,2],"c":{"x":"y"}}', { "idempotency-key": KEY }));
    await r(post('{\n  "c": { "x": "y" },\n\t"b": [ 1, 2 ],   "a": 1 }', { "idempotency-key": KEY }));
    await r(post('{"a":1,"b":[2,1],"c":{"x":"y"}}', { "idempotency-key": KEY }));
    const hashes = begin.mock.calls.map((c) => (c[1] as { requestHash: string }).requestHash);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[0]);
  });

  it("même clé + même corps sur un autre chemin ou une autre méthode => empreinte différente", async () => {
    const r = route();
    const mk = (path: string, method: string) =>
      new Request(`http://localhost:3000${path}`, {
        method,
        headers: { "content-type": "application/json", "idempotency-key": KEY },
        body: JSON.stringify({ name: "a" }),
      });
    await r(mk("/api/x", "POST"));
    await r(mk("/api/y", "POST"));
    await r(mk("/api/x", "PUT"));
    const h = begin.mock.calls.map((c) => (c[1] as { requestHash: string }).requestHash);
    expect(new Set(h).size).toBe(3);
  });
});

describe("limitation de débit : contrat de transmission", () => {
  it.each(["mutation", "sensitive"] as const)("portée %s transmise avec (organisation, utilisateur)", async (scope) => {
    await route({ rateLimit: scope, idempotency: "none" })(post({ name: "a" }));
    expect(takeToken).toHaveBeenCalledWith({ organizationId: ORG, userId: USER, scope });
    expect(JSON.stringify(takeToken.mock.calls)).not.toMatch(/@|Acme/);
  });

  it("429 : Retry-After entier positif", async () => {
    takeToken.mockResolvedValue({ allowed: false, retryAfterSeconds: 9 });
    const res = await route()(post({ name: "a" }, { "idempotency-key": KEY }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("9");
  });

  it("limiteur en panne (ServiceError) -> 503 et aucune mutation", async () => {
    takeToken.mockRejectedValue(new ServiceError("service_unavailable"));
    const res = await route()(post({ name: "a" }, { "idempotency-key": KEY }));
    expect(res.status).toBe(503);
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect([begin, handler, complete].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it("une exception NON ServiceError du limiteur ne laisse pas passer la mutation", async () => {
    takeToken.mockRejectedValue(new Error("ECONNRESET"));
    const res = await route()(post({ name: "a" }, { "idempotency-key": KEY }));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(handler).not.toHaveBeenCalled();
  });

  it("rateLimit 'none' : limiteur jamais consulté", async () => {
    await route({ rateLimit: "none", idempotency: "none" })(post({ name: "a" }));
    expect(takeToken).not.toHaveBeenCalled();
  });
});

describe("withAction : mêmes garanties, codes seulement", () => {
  type S = { status: "idle" | "error" | "success"; code?: string };
  const fd = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };
  const build = (over: Record<string, unknown>, fn: () => Promise<unknown>) =>
    withAction<Body, S>(
      {
        name: "x.act",
        auth: "tenant",
        schema,
        fields: ["name"],
        permission: { action: "invite", resource: "members" },
        rateLimit: "sensitive",
        idempotency: { mode: "required", storeResponse: true },
        failure: ({ code }: { code: string }) => ({ status: "error", code }),
        loginPath: () => "/fr/login",
        ...over,
      } as never,
      fn as never,
    ) as (p: S, f: FormData) => Promise<S>;
  const okAction = (over: Record<string, unknown> = {}) =>
    build(over, async () => (log.push("handler"), { status: "success" }));

  it("ordre auth, rate, begin, handler, complete", async () => {
    const r = await okAction()({ status: "idle" }, fd({ name: "a", idempotency_key: KEY }));
    expect(r).toEqual({ status: "success" });
    expect(log).toEqual(["auth", "rate", "begin", "handler", "complete"]);
  });

  it.each(ALL_CODES.filter((c) => c !== "unauthenticated"))("handler lève %s -> état d'erreur portant uniquement le code", async (code) => {
    const a = build({ rateLimit: "none", idempotency: "none" }, async () => {
      throw new ServiceError(code);
    });
    expect(await a({ status: "idle" }, fd({ name: "a" }))).toEqual({ status: "error", code });
  });

  it("valeur levée hostile -> état internal_error sans texte", async () => {
    const a = build({ rateLimit: "none", idempotency: "none" }, async () => {
      throw SQL;
    });
    const r = await a({ status: "idle" }, fd({ name: "a" }));
    expect(JSON.stringify(r)).not.toContain("victim");
    expect(r).toEqual({ status: "error", code: "internal_error" });
  });

  it("permission refusée : ni débit ni begin", async () => {
    getTenantContext.mockImplementation(async () => (log.push("auth"), tenant("analyst")));
    const r = await okAction()({ status: "idle" }, fd({ name: "a", idempotency_key: KEY }));
    expect(r).toEqual({ status: "error", code: "forbidden" });
    expect(log).toEqual(["auth"]);
  });

  it("limiteur en panne -> service_unavailable et handler non exécuté", async () => {
    takeToken.mockRejectedValue(new ServiceError("service_unavailable"));
    const r = await okAction()({ status: "idle" }, fd({ name: "a", idempotency_key: KEY }));
    expect(r).toEqual({ status: "error", code: "service_unavailable" });
    expect(log).not.toContain("handler");
  });

  it("champ hors liste fermée ignoré (organization_id forgé n'atteint pas le schéma)", async () => {
    const seen = vi.fn();
    const spy: ServiceSchema<Body> = { safeParse: (x) => (seen(x), schema.safeParse(x)) };
    await okAction({ schema: spy })({ status: "idle" }, fd({ name: "a", organization_id: "evil", idempotency_key: KEY }));
    expect(seen.mock.calls[0]![0]).not.toHaveProperty("organization_id");
  });
});
