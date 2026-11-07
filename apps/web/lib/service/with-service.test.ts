import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const KEY = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ATTEMPT = "11111111-2222-4333-8444-555555555555";
const HASH_RE = /^[0-9a-f]{64}$/;

/** Journal d'ordre des étapes du pipeline. */
const order: string[] = [];

const getTenantContext = vi.fn();
const getClaims = vi.fn();
const takeToken = vi.fn();
const begin = vi.fn();
const complete = vi.fn();
const abandon = vi.fn();
const redirectFn = vi.fn();

const fakeClient = { auth: { getClaims } };

vi.mock("../supabase/server", () => ({ createClient: async () => fakeClient }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirectFn(url);
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${url};307;` });
  },
}));
vi.mock("../tenant/context", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTenantContext: (...args: unknown[]) => getTenantContext(...args),
}));
vi.mock("./rate-limit", () => ({ LIMITS: {}, takeToken: (...args: unknown[]) => takeToken(...args) }));
vi.mock("./idempotency", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  idempotencyBegin: (...args: unknown[]) => begin(...args),
  idempotencyComplete: (...args: unknown[]) => complete(...args),
  idempotencyAbandon: (...args: unknown[]) => abandon(...args),
}));

import { TenantError } from "../tenant/tenant-error";
import { ServiceError } from "./errors";
import {
  listRegisteredActions,
  withAction,
  withRoute,
  redirectTo,
  type RouteResult,
  type ServiceSchema,
  type TenantActionOptions,
} from "./with-service";

type Body = { name: string; organization_id?: string };

const schema: ServiceSchema<Body> = {
  safeParse(raw) {
    const r = raw as Record<string, unknown> | null;
    if (r && typeof r === "object" && typeof r.name === "string" && r.name.length > 0) {
      return { success: true, data: r as Body };
    }
    return { success: false, error: { issues: [{ code: "too_small", path: ["name"] }] } };
  },
};

const tenantCtx = (role = "company_owner", organizationId = ORG) => ({
  userId: USER,
  organizationId,
  role,
  organization: { id: organizationId, name: "X", slug: "x", locale: "fr", timezone: "UTC" },
});

function req(body: unknown, headers: Record<string, string> = {}, init: RequestInit = {}): Request {
  return new Request("http://localhost:3000/api/things", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

const handler = vi.fn(async (): Promise<RouteResult> => {
  order.push("handler");
  return { status: 201, body: { ok: true } };
});

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  getTenantContext.mockImplementation(async () => {
    order.push("auth");
    return tenantCtx();
  });
  getClaims.mockImplementation(async () => {
    order.push("auth");
    return { data: { claims: { sub: USER } }, error: null };
  });
  takeToken.mockImplementation(async () => {
    order.push("rate");
    return { allowed: true, retryAfterSeconds: 0 };
  });
  begin.mockImplementation(async () => {
    order.push("begin");
    return { state: "new", attemptId: ATTEMPT };
  });
  complete.mockImplementation(async () => {
    order.push("complete");
  });
  abandon.mockImplementation(async () => {
    order.push("abandon");
  });
  handler.mockImplementation(async (): Promise<RouteResult> => {
    order.push("handler");
    return { status: 201, body: { ok: true } };
  });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

const tenantRoute = (over: Record<string, unknown> = {}) =>
  withRoute(
    {
      name: "things.create",
      auth: "tenant",
      schema,
      permission: { action: "invite", resource: "members", ctx: () => ({ assignedRole: "analyst" }) },
      rateLimit: "sensitive",
      idempotency: { mode: "required", storeResponse: true },
      ...over,
    },
    handler,
  );

describe("withRoute : ordre du pipeline", () => {
  it("auth -> rate limit -> begin -> handler -> complete, dans cet ordre", async () => {
    const res = await tenantRoute()(req({ name: "A" }, { "idempotency-key": KEY }));
    expect(res.status).toBe(201);
    expect(order).toEqual(["auth", "rate", "begin", "handler", "complete"]);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("rien n'est appelé avant la validation : taille, type, JSON, schéma", async () => {
    const route = tenantRoute();
    const bad: Request[] = [
      req({ name: "A" }, { "content-length": "99999" }),
      req({ name: "A" }, { "content-type": "text/plain" }),
      req("{pas du json"),
      req({ name: "" }),
      req({ name: "A" }, { "content-length": "abc" }),
    ];
    const statuses: number[] = [];
    for (const r of bad) statuses.push((await route(r)).status);
    expect(statuses).toEqual([413, 400, 400, 400, 400]);
    expect(order).toEqual([]);
    expect(getTenantContext).not.toHaveBeenCalled();
  });

  it("corps réel > limite (sans Content-Length) -> 413 ; la limite est configurable et mesurée en octets", async () => {
    const route = tenantRoute({ bodyLimitBytes: 64 });
    const big = JSON.stringify({ name: "é".repeat(40) }); // 80 octets, 40 caractères
    const res = await route(new Request("http://localhost/api/things", { method: "POST", headers: { "content-type": "application/json" }, body: big }));
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe("payload_too_large");
  });

  it("erreur de schéma : aucun détail de champ dans le corps HTTP", async () => {
    const res = await tenantRoute()(req({ name: "" }));
    expect(await res.json()).toEqual({ code: "validation_failed", message: expect.any(String), request_id: expect.any(String) });
  });
});

describe("withRoute : authentification et organisation", () => {
  it.each([
    ["unauthenticated", 401],
    ["no_organization", 403],
    ["organization_selection_required", 403],
    ["forbidden", 403],
    ["organization_inactive", 403],
  ] as const)("TenantError %s -> %i", async (code, status) => {
    getTenantContext.mockRejectedValue(new TenantError(code));
    const res = await tenantRoute()(req({ name: "A" }, { "idempotency-key": KEY }));
    expect(res.status).toBe(status);
    expect(handler).not.toHaveBeenCalled();
    expect(takeToken).not.toHaveBeenCalled();
  });

  it("une panne de lecture des adhésions -> 500 internal_error sans fuite du message", async () => {
    getTenantContext.mockRejectedValue(new Error("membership_lookup_failed secret detail"));
    const res = await tenantRoute()(req({ name: "A" }, { "idempotency-key": KEY }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });

  it("organization_id du client différent du contexte -> 403, même casse différente acceptée si identique", async () => {
    const route = tenantRoute();
    const denied = await route(req({ name: "A", organization_id: OTHER_ORG }, { "idempotency-key": KEY }));
    expect(denied.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    const ok = await route(req({ name: "A", organization_id: ORG.toUpperCase() }, { "idempotency-key": KEY }));
    expect(ok.status).toBe(201);
  });

  it("auth 'user' : 401 sans claims valides ; forbidOrganizationId refuse tout organization_id", async () => {
    const route = withRoute(
      { name: "things.user", auth: "user", schema, rateLimit: "mutation", idempotency: "none", forbidOrganizationId: true },
      async (ctx) => ({ status: 200, body: { userId: ctx.userId, org: ctx.organizationId } }),
    );
    getClaims.mockResolvedValueOnce({ data: null, error: null });
    expect((await route(req({ name: "A" }))).status).toBe(401);
    expect((await route(req({ name: "A", organization_id: null as unknown as string }))).status).toBe(403);
    const res = await route(req({ name: "A" }));
    expect(await res.json()).toEqual({ userId: USER, org: null });
  });

  it("can() refuse -> 403 AVANT la limitation de débit et l'idempotence", async () => {
    getTenantContext.mockResolvedValue(tenantCtx("analyst"));
    const res = await tenantRoute()(req({ name: "A" }, { "idempotency-key": KEY }));
    expect(res.status).toBe(403);
    expect(takeToken).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
  });
});

describe("withRoute : limitation de débit", () => {
  it("transmet (organisation, utilisateur, portée) et ne dépend jamais d'un e-mail", async () => {
    await tenantRoute()(req({ name: "A" }, { "idempotency-key": KEY }));
    expect(takeToken).toHaveBeenCalledWith({ organizationId: ORG, userId: USER, scope: "sensitive" });
  });

  it("refus -> 429 rate_limited avec Retry-After ; ni begin ni handler", async () => {
    takeToken.mockResolvedValue({ allowed: false, retryAfterSeconds: 6 });
    const res = await tenantRoute()(req({ name: "A" }, { "idempotency-key": KEY }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("6");
    expect((await res.json()).code).toBe("rate_limited");
    expect(begin).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("panne du backend -> ÉCHEC FERMÉ : 503 service_unavailable, aucune mutation", async () => {
    takeToken.mockRejectedValue(new ServiceError("service_unavailable"));
    const res = await tenantRoute()(req({ name: "A" }, { "idempotency-key": KEY }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("service_unavailable");
    expect(handler).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
  });

  it("rateLimit 'none' ne consomme aucun jeton", async () => {
    await tenantRoute({ rateLimit: "none" })(req({ name: "A" }, { "idempotency-key": KEY }));
    expect(takeToken).not.toHaveBeenCalled();
  });
});

describe("withRoute : idempotence", () => {
  it("required : clé absente ou invalide -> 400, handler non appelé", async () => {
    const route = tenantRoute();
    for (const key of [undefined, "court", "a b c d e f g h", "é".repeat(10)]) {
      const res = await route(req({ name: "A" }, key === undefined ? {} : { "idempotency-key": key }));
      expect(res.status).toBe(400);
    }
    expect(handler).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
  });

  it("optional : clé absente -> pas d'idempotence ; clé présente mais invalide -> 400", async () => {
    const route = tenantRoute({ idempotency: { mode: "optional", storeResponse: true } });
    expect((await route(req({ name: "A" }))).status).toBe(201);
    expect(begin).not.toHaveBeenCalled();
    expect((await route(req({ name: "A" }, { "idempotency-key": "court" }))).status).toBe(400);
  });

  it("begin reçoit organisation, clé et empreinte SHA-256 ; la même requête donne la même empreinte", async () => {
    const route = tenantRoute();
    await route(req({ name: "A", z: 1 }, { "idempotency-key": KEY }));
    await route(req('{"z":1,"name":"A"}', { "idempotency-key": KEY }));
    const first = begin.mock.calls[0]?.[1] as { organizationId: string; key: string; requestHash: string };
    const second = begin.mock.calls[1]?.[1] as { requestHash: string };
    expect(first).toMatchObject({ organizationId: ORG, key: KEY });
    expect(first.requestHash).toMatch(HASH_RE);
    expect(second.requestHash).toBe(first.requestHash);
  });

  it("un autre corps donne une autre empreinte", async () => {
    const route = tenantRoute();
    await route(req({ name: "A" }, { "idempotency-key": KEY }));
    await route(req({ name: "B" }, { "idempotency-key": KEY }));
    const hashes = begin.mock.calls.map((c) => (c[1] as { requestHash: string }).requestHash);
    expect(new Set(hashes).size).toBe(2);
  });

  it("conflict -> 422 idempotency_conflict ; in_progress -> 409 idempotency_in_progress ; handler non appelé", async () => {
    const route = tenantRoute();
    begin.mockResolvedValueOnce({ state: "conflict" });
    const conflict = await route(req({ name: "A" }, { "idempotency-key": KEY }));
    expect(conflict.status).toBe(422);
    expect((await conflict.json()).code).toBe("idempotency_conflict");
    begin.mockResolvedValueOnce({ state: "in_progress" });
    const busy = await route(req({ name: "A" }, { "idempotency-key": KEY }));
    expect(busy.status).toBe(409);
    expect((await busy.json()).code).toBe("idempotency_in_progress");
    expect(handler).not.toHaveBeenCalled();
    expect(abandon).not.toHaveBeenCalled();
  });

  it("replay avec réponse conservée : même statut, même corps, Idempotent-Replay, sans double effet", async () => {
    begin.mockResolvedValueOnce({ state: "replay", statusCode: 201, response: { body: { ok: true, n: 1 } } });
    const res = await tenantRoute()(req({ name: "A" }, { "idempotency-key": KEY }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, n: 1 });
    expect(res.headers.get("idempotent-replay")).toBe("true");
    expect(handler).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("replay sans corps conservé (storeResponse false) -> 409 duplicate_request + Idempotent-Replay", async () => {
    begin.mockResolvedValueOnce({ state: "replay", statusCode: 201, response: { replayed: true } });
    const res = await tenantRoute({ idempotency: { mode: "required", storeResponse: false } })(req({ name: "A" }, { "idempotency-key": KEY }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("duplicate_request");
    expect(res.headers.get("idempotent-replay")).toBe("true");
    expect(handler).not.toHaveBeenCalled();
  });

  it("succès : complete avec { body } (storeResponse true) ; avec { replayed: true } SEUL (storeResponse false)", async () => {
    await tenantRoute()(req({ name: "A" }, { "idempotency-key": KEY }));
    expect(complete.mock.calls[0]?.[1]).toMatchObject({ organizationId: ORG, key: KEY, statusCode: 201, response: { body: { ok: true } } });

    complete.mockClear();
    handler.mockResolvedValueOnce({ status: 201, body: { invitePath: "/fr/invite/SECRET-TOKEN" } });
    await tenantRoute({ idempotency: { mode: "required", storeResponse: false } })(req({ name: "A" }, { "idempotency-key": KEY }));
    expect(complete.mock.calls[0]?.[1]).toMatchObject({ statusCode: 201, response: { replayed: true } });
    expect(JSON.stringify(complete.mock.calls)).not.toContain("SECRET-TOKEN");
  });

  it("le handler lève une erreur inattendue -> abandon, 500 normalisé sans le texte de l'erreur", async () => {
    handler.mockRejectedValueOnce(new Error("boom: duplicate key organizations_slug_key"));
    const res = await tenantRoute()(req({ name: "A" }, { "idempotency-key": KEY }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("boom");
    expect(abandon).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it("le handler renvoie une erreur HTTP (>= 400) -> abandon, jamais complete", async () => {
    handler.mockResolvedValueOnce({ status: 403, body: { code: "forbidden" } });
    const res = await tenantRoute()(req({ name: "A" }, { "idempotency-key": KEY }));
    expect(res.status).toBe(403);
    expect(abandon).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it("complete en panne après un succès : la réponse de succès est rendue et la ligne n'est PAS abandonnée", async () => {
    complete.mockRejectedValue(new ServiceError("internal_error"));
    const res = await tenantRoute()(req({ name: "A" }, { "idempotency-key": KEY }));
    expect(res.status).toBe(201);
    expect(complete).toHaveBeenCalledTimes(2); // corps complet puis forme minimale
    expect(abandon).not.toHaveBeenCalled();
  });

  it("begin en panne -> erreur normalisée, handler non appelé", async () => {
    begin.mockRejectedValueOnce(new ServiceError("forbidden"));
    const res = await tenantRoute()(req({ name: "A" }, { "idempotency-key": KEY }));
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("withRoute : erreurs normalisées, request_id, journaux", () => {
  it("toute erreur porte { code, message, request_id } et x-request-id : un uuid serveur, JAMAIS celui du client", async () => {
    getTenantContext.mockRejectedValue(new TenantError("unauthenticated"));
    const res = await tenantRoute()(req({ name: "A" }, { "x-request-id": "req-12345678" }));
    const requestId = res.headers.get("x-request-id");
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(requestId).not.toBe("req-12345678");
    expect(await res.json()).toEqual({ code: "unauthenticated", message: expect.any(String), request_id: requestId });
  });

  it("une ligne JSON par échec : seulement event, code, request_id, client_request_id, organization_id, name", async () => {
    takeToken.mockResolvedValue({ allowed: false, retryAfterSeconds: 3 });
    await tenantRoute()(req({ name: "Données Secrètes" }, { "idempotency-key": KEY, "x-request-id": "req-12345678" }));
    const lines = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["client_request_id", "code", "event", "name", "organization_id", "request_id"]);
    expect(parsed).toMatchObject({ event: "service_failure", code: "rate_limited", name: "things.create", organization_id: ORG, client_request_id: "req-12345678" });
    expect(parsed.request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(parsed.request_id).not.toBe("req-12345678");
    expect(lines[0]).not.toContain("Secrètes");
    expect(lines[0]).not.toContain(KEY);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("les pannes (5xx) passent par console.error, sans message d'erreur", async () => {
    handler.mockRejectedValueOnce(new Error("token=abc123 leaked"));
    await tenantRoute()(req({ name: "A" }, { "idempotency-key": KEY }));
    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).toContain("internal_error");
    expect(logged).not.toContain("abc123");
  });
});

// ---------------------------------------------------------------------------
// Server Actions
// ---------------------------------------------------------------------------

type State = { status: "idle" | "error" | "success"; code?: string; fieldErrors?: Record<string, string[]>; secret?: string };
const IDLE: State = { status: "idle" };

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

const actionHandler = vi.fn(async (): Promise<State | ReturnType<typeof redirectTo>> => {
  order.push("handler");
  return { status: "success" };
});

const tenantAction = (over: Record<string, unknown> = {}) =>
  withAction<Body, State>(
    {
      name: "things.act",
      auth: "tenant",
      schema,
      fields: ["name", "organization_id"],
      permission: { action: "invite", resource: "members", ctx: () => ({ assignedRole: "analyst" }) },
      rateLimit: "sensitive",
      idempotency: { mode: "required", storeResponse: true },
      failure: ({ code, fieldErrors }) => ({ status: "error", code, ...(fieldErrors ? { fieldErrors } : {}) }),
      loginPath: (fd) => `/${String(fd.get("uiLocale") ?? "fr")}/login`,
      ...over,
    },
    actionHandler,
  );

describe("withAction", () => {
  beforeEach(() => {
    actionHandler.mockImplementation(async () => {
      order.push("handler");
      return { status: "success" };
    });
  });

  it("ordre identique aux routes ; seule la liste fermée de champs atteint le schéma", async () => {
    const seen: unknown[] = [];
    const spy: ServiceSchema<Body> = { safeParse: (raw) => (seen.push(raw), schema.safeParse(raw)) };
    const state = await tenantAction({ schema: spy })(IDLE, form({ name: "A", idempotency_key: KEY, evil: "x", "$ACTION_ID_1": "y" }));
    expect(state).toEqual({ status: "success" });
    expect(order).toEqual(["auth", "rate", "begin", "handler", "complete"]);
    expect(seen).toEqual([{ name: "A", organization_id: undefined }]);
  });

  it("clé absente (required) -> invalid_input... ici validation_failed, handler non appelé", async () => {
    const state = await tenantAction()(IDLE, form({ name: "A" }));
    expect(state).toMatchObject({ status: "error", code: "validation_failed" });
    expect(actionHandler).not.toHaveBeenCalled();
  });

  it("erreurs de champ : noms et codes de validation uniquement", async () => {
    const state = await tenantAction()(IDLE, form({ name: "", idempotency_key: KEY }));
    expect(state).toEqual({ status: "error", code: "validation_failed", fieldErrors: { name: ["too_small"] } });
    expect(order).toEqual([]);
  });

  it("session absente -> redirection vers la connexion de la locale (hors try/catch)", async () => {
    getTenantContext.mockRejectedValue(new TenantError("unauthenticated"));
    await expect(tenantAction()(IDLE, form({ name: "A", idempotency_key: KEY, uiLocale: "ar" }))).rejects.toMatchObject({ digest: expect.stringContaining("/ar/login") });
    expect(redirectFn).toHaveBeenCalledWith("/ar/login");
  });

  it("autre TenantError -> état forbidden", async () => {
    getTenantContext.mockRejectedValue(new TenantError("organization_inactive"));
    expect(await tenantAction()(IDLE, form({ name: "A", idempotency_key: KEY }))).toMatchObject({ status: "error", code: "forbidden" });
  });

  it("organization_id d'un autre tenant -> forbidden, handler non appelé", async () => {
    const state = await tenantAction()(IDLE, form({ name: "A", organization_id: OTHER_ORG, idempotency_key: KEY }));
    expect(state).toMatchObject({ status: "error", code: "forbidden" });
    expect(actionHandler).not.toHaveBeenCalled();
  });

  it("rate_limited et service_unavailable arrivent comme codes d'état", async () => {
    takeToken.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 2 });
    expect(await tenantAction()(IDLE, form({ name: "A", idempotency_key: KEY }))).toMatchObject({ code: "rate_limited" });
    takeToken.mockRejectedValueOnce(new ServiceError("service_unavailable"));
    expect(await tenantAction()(IDLE, form({ name: "A", idempotency_key: KEY }))).toMatchObject({ code: "service_unavailable" });
    expect(actionHandler).not.toHaveBeenCalled();
  });

  it("replay avec état conservé -> le même état, sans nouvel effet", async () => {
    begin.mockResolvedValueOnce({ state: "replay", statusCode: 200, response: { body: { status: "success" } } });
    expect(await tenantAction()(IDLE, form({ name: "A", idempotency_key: KEY }))).toEqual({ status: "success" });
    expect(actionHandler).not.toHaveBeenCalled();
  });

  it("replay sans état conservé -> duplicate_request ; conflict -> idempotency_conflict ; in_progress -> idempotency_in_progress", async () => {
    begin.mockResolvedValueOnce({ state: "replay", statusCode: 200, response: { replayed: true } });
    expect(await tenantAction()(IDLE, form({ name: "A", idempotency_key: KEY }))).toMatchObject({ code: "duplicate_request" });
    begin.mockResolvedValueOnce({ state: "conflict" });
    expect(await tenantAction()(IDLE, form({ name: "A", idempotency_key: KEY }))).toMatchObject({ code: "idempotency_conflict" });
    begin.mockResolvedValueOnce({ state: "in_progress" });
    expect(await tenantAction()(IDLE, form({ name: "A", idempotency_key: KEY }))).toMatchObject({ code: "idempotency_in_progress" });
    expect(actionHandler).not.toHaveBeenCalled();
  });

  it("état d'erreur renvoyé par le handler -> abandon (un nouvel essai peut ré-exécuter), jamais complete", async () => {
    actionHandler.mockResolvedValueOnce({ status: "error", code: "forbidden" });
    expect(await tenantAction()(IDLE, form({ name: "A", idempotency_key: KEY }))).toMatchObject({ code: "forbidden" });
    expect(abandon).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it("storeResponse false : l'état (et son secret) n'est jamais envoyé à complete", async () => {
    actionHandler.mockResolvedValueOnce({ status: "success", secret: "TOKEN-123" });
    const state = await tenantAction({ idempotency: { mode: "required", storeResponse: false } })(IDLE, form({ name: "A", idempotency_key: KEY }));
    expect(state).toMatchObject({ secret: "TOKEN-123" });
    expect(complete.mock.calls[0]?.[1]).toMatchObject({ response: { replayed: true } });
    expect(JSON.stringify(complete.mock.calls)).not.toContain("TOKEN-123");
  });

  it("exception du handler -> abandon puis état generic/internal_error sans texte", async () => {
    actionHandler.mockRejectedValueOnce(new Error("boom secret"));
    const state = await tenantAction()(IDLE, form({ name: "A", idempotency_key: KEY }));
    expect(state).toMatchObject({ status: "error", code: "internal_error" });
    expect(JSON.stringify(state)).not.toContain("boom");
    expect(abandon).toHaveBeenCalledTimes(1);
  });

  it("redirectTo() : redirection exécutée APRÈS complete", async () => {
    actionHandler.mockResolvedValueOnce(redirectTo("/fr/dashboard"));
    await expect(tenantAction()(IDLE, form({ name: "A", idempotency_key: KEY }))).rejects.toMatchObject({ digest: expect.stringContaining("/fr/dashboard") });
    expect(order.at(-1)).toBe("complete");
  });

  it("une erreur de contrôle de flux Next levée par le handler est propagée (pas avalée)", async () => {
    actionHandler.mockRejectedValueOnce(Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/x;307;" }));
    await expect(tenantAction()(IDLE, form({ name: "A", idempotency_key: KEY }))).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
    expect(abandon).toHaveBeenCalledTimes(1);
  });

  it("auth 'user' sans idempotence : la clé est ignorée, organisation null pour la limite de débit", async () => {
    const action = withAction<Body, State>(
      {
        name: "things.user",
        auth: "user",
        schema,
        fields: ["name"],
        rateLimit: "mutation",
        idempotency: "none",
        failure: ({ code }) => ({ status: "error", code }),
        loginPath: () => "/fr/login",
      },
      async () => ({ status: "success" }),
    );
    expect(await action(IDLE, form({ name: "A", idempotency_key: KEY }))).toEqual({ status: "success" });
    expect(takeToken).toHaveBeenCalledWith({ organizationId: null, userId: USER, scope: "mutation" });
    expect(begin).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tentatives d'idempotence (attempt_id), quota, secrets, étape zod des routes
// ---------------------------------------------------------------------------

describe("idempotence : attempt_id enfilé de begin à complete / abandon", () => {
  it("complete reçoit l'attempt_id renvoyé par begin (et celui de CETTE requête seulement)", async () => {
    const OTHER_ATTEMPT = "99999999-8888-4777-8666-555555555555";
    await tenantRoute()(req({ name: "A" }, { "idempotency-key": KEY }));
    begin.mockResolvedValueOnce({ state: "new", attemptId: OTHER_ATTEMPT });
    await tenantRoute()(req({ name: "A" }, { "idempotency-key": KEY }));
    expect(complete.mock.calls[0]?.[1]).toMatchObject({ attemptId: ATTEMPT });
    expect(complete.mock.calls[1]?.[1]).toMatchObject({ attemptId: OTHER_ATTEMPT });
  });

  it("abandon (exception du handler) reçoit l'attempt_id du begin", async () => {
    handler.mockRejectedValueOnce(new Error("boom"));
    await tenantRoute()(req({ name: "A" }, { "idempotency-key": KEY }));
    expect(abandon.mock.calls[0]?.[1]).toMatchObject({ organizationId: ORG, key: KEY, attemptId: ATTEMPT });
  });

  it("abandon (réponse >= 400) reçoit l'attempt_id du begin", async () => {
    handler.mockResolvedValueOnce({ status: 403, body: {} });
    await tenantRoute()(req({ name: "A" }, { "idempotency-key": KEY }));
    expect(abandon.mock.calls[0]?.[1]).toMatchObject({ attemptId: ATTEMPT });
  });

  it("Server Action : complete et abandon reçoivent l'attempt_id", async () => {
    await tenantAction()(IDLE, form({ name: "A", idempotency_key: KEY }));
    expect(complete.mock.calls[0]?.[1]).toMatchObject({ attemptId: ATTEMPT });
    actionHandler.mockResolvedValueOnce({ status: "error", code: "x" });
    await tenantAction()(IDLE, form({ name: "A", idempotency_key: KEY }));
    expect(abandon.mock.calls[0]?.[1]).toMatchObject({ attemptId: ATTEMPT });
  });

  it("quota d'idempotence atteint (begin lève quota_exceeded) -> 429 quota_exceeded, handler non appelé, rien à abandonner", async () => {
    begin.mockRejectedValueOnce(new ServiceError("quota_exceeded"));
    const res = await tenantRoute()(req({ name: "A" }, { "idempotency-key": KEY }));
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("quota_exceeded");
    expect(handler).not.toHaveBeenCalled();
    expect(abandon).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("quota d'idempotence atteint dans une Server Action -> code quota_exceeded transmis à failure()", async () => {
    begin.mockRejectedValueOnce(new ServiceError("quota_exceeded"));
    const state = await tenantAction()(IDLE, form({ name: "A", idempotency_key: KEY }));
    expect(state).toMatchObject({ status: "error", code: "quota_exceeded" });
    expect(actionHandler).not.toHaveBeenCalled();
  });
});

describe("contrat : aucun secret dans une réponse conservée", () => {
  const secretAction = (idempotency: unknown, extra: Record<string, unknown> = {}) =>
    withAction<Body, State>(
      {
        name: `contract.secret.${Math.random().toString(36).slice(2)}`,
        auth: "tenant",
        schema,
        fields: ["name"],
        rateLimit: "none",
        idempotency: idempotency as never,
        failure: ({ code }) => ({ status: "error", code }),
        loginPath: () => "/fr/login",
        ...extra,
      },
      async () => ({ status: "success", invitePath: "/fr/invite/TOKEN-XYZ" }) as unknown as State,
    );

  it("une action qui DÉCLARE un champ secret ne peut pas avoir storeResponse: true (échec à la déclaration)", () => {
    expect(() => secretAction({ mode: "required", storeResponse: true }, { secretFields: ["invitePath"] })).toThrow(/storeResponse=true/);
    expect(() => secretAction({ mode: "optional", storeResponse: true }, { secretFields: ["invitePath"] })).toThrow(/invitePath/);
  });

  it("avec storeResponse: false (ou sans idempotence) la déclaration d'un champ secret est acceptée", () => {
    expect(() => secretAction({ mode: "required", storeResponse: false }, { secretFields: ["invitePath"] })).not.toThrow();
    expect(() => secretAction("none", { secretFields: ["invitePath"] })).not.toThrow();
  });

  it("garde d'exécution : un état contenant invitePath n'est jamais conservé, même si storeResponse: true", async () => {
    const run = secretAction({ mode: "required", storeResponse: true });
    const state = await run(IDLE, form({ name: "A", idempotency_key: KEY }));
    expect(state).toMatchObject({ status: "success", invitePath: "/fr/invite/TOKEN-XYZ" }); // l'appelant le reçoit une fois
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[1]).toMatchObject({ response: { replayed: true } });
    expect(JSON.stringify(complete.mock.calls)).not.toContain("TOKEN-XYZ");
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).toContain("secret_state_not_stored");
  });

  it.each(["token", "secret", "password"])("garde d'exécution : le champ %s n'est jamais conservé non plus", async (name) => {
    actionHandler.mockResolvedValueOnce({ status: "success", [name]: "S3CR3T" } as unknown as State);
    await tenantAction()(IDLE, form({ name: "A", idempotency_key: KEY }));
    expect(JSON.stringify(complete.mock.calls)).not.toContain("S3CR3T");
  });

  it("storeResponse est OBLIGATOIRE dans l'option d'idempotence (erreur de type sans lui)", () => {
    const options: TenantActionOptions<Body, State> = {
      name: "contract.typing",
      auth: "tenant",
      schema,
      fields: ["name"],
      rateLimit: "none",
      // @ts-expect-error storeResponse est obligatoire : aucune valeur par défaut implicite
      idempotency: { mode: "required" },
      failure: ({ code }): State => ({ status: "error", code }),
      loginPath: () => "/fr/login",
    };
    expect(options.idempotency).not.toHaveProperty("storeResponse");
  });

  it("registre : une action qui conserve sa réponse n'a aucun champ secret déclaré", () => {
    secretAction({ mode: "required", storeResponse: false }, { secretFields: ["invitePath"] });
    tenantAction();
    const all = listRegisteredActions();
    expect(all.length).toBeGreaterThan(1);
    for (const action of all) {
      if (action.storeResponse === true) expect(action.secretFields, action.name).toEqual([]);
    }
  });
});

describe("withRoute : étape zod unique (corps + en-têtes) avant l'authentification", () => {
  const userRoute = () =>
    withRoute(
      {
        name: "things.user",
        auth: "user",
        schema: {
          safeParse(raw: unknown) {
            const { body, key } = raw as { body: { name?: unknown }; key: string | null };
            return typeof body?.name === "string" && key
              ? { success: true as const, data: { name: body.name, key } }
              : { success: false as const, error: { issues: [{ code: "invalid_type", path: [] as PropertyKey[] }] } };
          },
        },
        input: (body: unknown, headers: Headers) => ({ body, key: headers.get("idempotency-key") }),
        rateLimit: "none",
        idempotency: "none",
        forbidOrganizationId: true,
      },
      async (_ctx, input) => ({ status: 200, body: input }),
    );

  it("l'en-tête atteint le schéma via `input` ; succès", async () => {
    const res = await userRoute()(req({ name: "A" }, { "idempotency-key": KEY }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "A", key: KEY });
  });

  it("en-tête absent -> 400 AVANT l'authentification (aucun appel d'auth)", async () => {
    const res = await userRoute()(req({ name: "A" }));
    expect(res.status).toBe(400);
    expect(getClaims).not.toHaveBeenCalled();
  });

  it("organization_id dans le corps -> 403 avant toute validation et avant l'authentification", async () => {
    const res = await userRoute()(req({ name: "", organization_id: ORG }));
    expect(res.status).toBe(403);
    expect(getClaims).not.toHaveBeenCalled();
  });

  it("le corps ne peut pas forger l'en-tête : un champ `key` du corps n'atteint pas la clé", async () => {
    const res = await userRoute()(req({ name: "A", key: "forged-key-123456" }));
    expect(res.status).toBe(400);
  });
});
