import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const KEY = "0f8fad5b-d9cb-469f-a165-70867728950e";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const getClaims = vi.fn();
const rpc = vi.fn();
const cookieSet = vi.fn();
const createClient = vi.fn();
const membershipReads: unknown[][] = [];

vi.mock("../../../lib/supabase/server", () => ({
  createClient: () => createClient(),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: cookieSet, get: vi.fn() }) }));

import { POST } from "./route";

const orgRow = {
  organization_id: ORG,
  role: "company_owner",
  organizations: { id: ORG, name: "Acme", slug: "acme-x1", locale: "ar", timezone: "UTC", status: "active" },
};

function client() {
  return {
    auth: { getClaims },
    rpc,
    from: () => {
      let calls = 0;
      const q: { select: () => unknown; eq: () => unknown } = {
        select: () => q,
        eq: () => {
          calls += 1;
          return calls === 2 ? Promise.resolve({ data: membershipReads.shift() ?? [], error: null }) : q;
        },
      };
      return q;
    },
  };
}

function req(body: unknown, headers: Record<string, string | null> = {}): Request {
  const h = new Headers({ "content-type": "application/json", "idempotency-key": KEY });
  for (const [k, v] of Object.entries(headers)) {
    if (v === null) h.delete(k);
    else h.set(k, v);
  }
  return new Request("http://localhost:3000/api/orgs", {
    method: "POST",
    headers: h,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  membershipReads.length = 0;
  createClient.mockImplementation(async () => client());
  getClaims.mockResolvedValue({ data: { claims: { sub: USER } }, error: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/orgs : en-tête Idempotency-Key", () => {
  it("absent -> 400 validation_failed, aucun RPC, aucun cookie", async () => {
    const res = await POST(req({ name: "A" }, { "idempotency-key": null }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation_failed");
    expect(rpc).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it.each([
    ["7 caractères", "abcdefg"],
    ["129 caractères", "a".repeat(129)],
    ["espace", "abcd efgh"],
    ["point", "abcdefg."],
    ["slash", "abc/defgh"],
    ["vide", ""],
  ])("invalide (%s) -> 400 validation_failed", async (_l, value) => {
    const res = await POST(req({ name: "A" }, { "idempotency-key": value }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation_failed");
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["8 caractères", "abcdefgh"],
    ["128 caractères", "a".repeat(128)],
  ])("valide (%s) -> la clé est transmise telle quelle à la base", async (_l, value) => {
    membershipReads.push([], [orgRow]);
    rpc.mockResolvedValue({ data: ORG, error: null });
    const res = await POST(req({ name: "A" }, { "idempotency-key": value }));
    expect(res.status).toBe(201);
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_creation_key: value });
  });

  it("l'authentification est vérifiée avant la clé : sans session ET sans clé -> 401", async () => {
    getClaims.mockResolvedValue({ data: null, error: null });
    const res = await POST(req({ name: "A" }, { "idempotency-key": null }));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/orgs : organization_id fourni par le client", () => {
  it.each([
    ["uuid arbitraire", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    ["uuid de sa propre organisation", ORG],
    ["null", null],
    ["chaîne vide", ""],
    ["nombre", 7],
    ["objet", { id: ORG }],
  ])("%s -> 403 forbidden (jamais ignoré en silence), pas de RPC, pas de cookie", async (_l, id) => {
    const res = await POST(req({ name: "Acme", organization_id: id }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "forbidden", message: expect.any(String), request_id: expect.stringMatching(UUID_RE) });
    expect(rpc).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("organization_id est refusé AVANT la validation du reste du corps (nom invalide inclus)", async () => {
    const res = await POST(req({ name: "", organization_id: ORG }));
    expect(res.status).toBe(403);
  });

  it.each([["role"], ["created_by"], ["slug"], ["user_id"], ["status"]])(
    "champ inconnu %s : 400 validation_failed, aucun RPC",
    async (field) => {
      const res = await POST(req({ name: "Acme", [field]: "company_owner" }));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("validation_failed");
      expect(rpc).not.toHaveBeenCalled();
      expect(cookieSet).not.toHaveBeenCalled();
    },
  );

  it("seuls name / locale / timezone atteignent la base", async () => {
    membershipReads.push([], [orgRow]);
    rpc.mockResolvedValue({ data: ORG, error: null });
    const res = await POST(req({ name: "Acme", locale: "en", timezone: "UTC" }));
    expect(res.status).toBe(201);
    expect(Object.keys(rpc.mock.calls[0]?.[1] as object).sort()).toEqual(["p_creation_key", "p_locale", "p_name", "p_timezone"]);
  });
});

describe("POST /api/orgs : erreurs normalisées et request_id", () => {
  it("génère un request_id uuid et le répète dans l'en-tête et le corps", async () => {
    const res = await POST(req({ name: "" }));
    const body = await res.json();
    expect(body.request_id).toMatch(UUID_RE);
    expect(res.headers.get("x-request-id")).toBe(body.request_id);
    expect(Object.keys(body).sort()).toEqual(["code", "message", "request_id"]);
  });

  it("reprend un x-request-id sûr du client", async () => {
    const res = await POST(req({ name: "" }, { "x-request-id": "trace-abc-12345" }));
    expect((await res.json()).request_id).toBe("trace-abc-12345");
    expect(res.headers.get("x-request-id")).toBe("trace-abc-12345");
  });

  it("remplace un x-request-id dangereux (espaces, trop court)", async () => {
    const res = await POST(req({ name: "" }, { "x-request-id": "bad id" }));
    expect((await res.json()).request_id).toMatch(UUID_RE);
  });

  it("le même request_id circule dans les erreurs 401, 403 et 500", async () => {
    const id = "trace-fixed-0001";
    getClaims.mockResolvedValue({ data: null, error: null });
    expect((await (await POST(req({ name: "A" }, { "x-request-id": id }))).json()).request_id).toBe(id);
    getClaims.mockResolvedValue({ data: { claims: { sub: USER } }, error: null });
    expect((await (await POST(req({ name: "A", organization_id: ORG }, { "x-request-id": id }))).json()).request_id).toBe(id);
    createClient.mockRejectedValue(new Error("boom"));
    expect((await (await POST(req({ name: "A" }, { "x-request-id": id }))).json()).request_id).toBe(id);
  });

  it("réponses d'erreur en no-store", async () => {
    const res = await POST(req({ name: "" }));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("Content-Length annoncé > 16384 -> 413 normalisé, rejet avant lecture du corps", async () => {
    const r = req({ name: "A" }, { "content-length": "16385", "x-request-id": "trace-big-00001" });
    const textSpy = vi.spyOn(r, "text");
    const res = await POST(r);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ code: "payload_too_large", message: expect.any(String), request_id: "trace-big-00001" });
    expect(textSpy).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("Content-Length illisible -> 400 sans RPC", async () => {
    const res = await POST(req({ name: "A" }, { "content-length": "abc" }));
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("corps réel > 16384 octets (sans Content-Length) -> 413 sans RPC", async () => {
    const res = await POST(req({ name: "A", padding: "x".repeat(17 * 1024) }));
    expect(res.status).toBe(413);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("la limite se mesure en OCTETS : ~10 000 caractères arabes (20 Ko) dépassent, même sous 16384 unités UTF-16", async () => {
    const body = JSON.stringify({ name: "A", padding: "ش".repeat(9000) });
    expect(body.length).toBeLessThan(16384);
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(16384);
    const res = await POST(req(body));
    expect(res.status).toBe(413);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("un corps multi-octets sous 16384 octets reste lu intégralement (nom arabe accepté)", async () => {
    membershipReads.push([], [orgRow]);
    rpc.mockResolvedValue({ data: ORG, error: null });
    const res = await POST(req({ name: "شركة الأمل" }));
    expect(res.status).toBe(201);
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_name: "شركة الأمل" });
  });

  it("content-type application/json; charset=utf-8 accepté", async () => {
    membershipReads.push([], [orgRow]);
    rpc.mockResolvedValue({ data: ORG, error: null });
    const res = await POST(req({ name: "A" }, { "content-type": "application/json; charset=utf-8" }));
    expect(res.status).toBe(201);
  });
});

describe("POST /api/orgs : correspondance des erreurs de la base", () => {
  it.each([
    ["idempotency_conflict", { code: "P0001", message: "idempotency_conflict" }, 422],
    ["validation_failed", { code: "22023", message: "validation_failed" }, 400],
    ["unauthenticated", { code: "28000", message: "unauthenticated" }, 401],
    ["JWT expiré PostgREST", { code: "PGRST301", message: "JWT expired" }, 401],
    ["privilège insuffisant", { code: "42501", message: "permission denied for function create_organization" }, 403],
    ["violation d'unicité", { code: "23505", message: 'duplicate key value violates unique constraint "organizations_slug_key"' }, 500],
    ["plan trial absent", { code: "XX000", message: "trial_plan_missing" }, 500],
    ["FK utilisateur absent", { code: "23503", message: "insert or update on table violates foreign key constraint" }, 500],
    ["inconnue", { code: "ZZZZZ", message: "something" }, 500],
  ])("%s -> %i", async (_l, error, status) => {
    membershipReads.push([]);
    rpc.mockResolvedValue({ data: null, error });
    const res = await POST(req({ name: "Acme" }));
    expect(res.status).toBe(status);
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("une erreur inconnue ne laisse fuiter ni message SQL, ni nom de contrainte, ni nom saisi", async () => {
    membershipReads.push([]);
    rpc.mockResolvedValue({
      data: null,
      error: {
        code: "23505",
        message: 'duplicate key value violates unique constraint "organizations_slug_key"',
        details: "Key (slug)=(acme-secret) already exists.",
        hint: "use another slug",
      },
    });
    const res = await POST(req({ name: "Nom Confidentiel" }));
    const raw = JSON.stringify(await res.json());
    for (const leak of ["duplicate", "organizations_slug_key", "acme-secret", "hint", "Nom Confidentiel", "23505", "stack", "at "]) {
      expect(raw).not.toContain(leak);
    }
  });

  it("une exception inattendue (client serveur indisponible) -> 500 normalisé, sans le message de l'exception", async () => {
    createClient.mockRejectedValue(new Error("SUPABASE_SECRET_KEY=abc leaked"));
    const res = await POST(req({ name: "A" }));
    expect(res.status).toBe(500);
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain("SUPABASE_SECRET_KEY");
    expect(JSON.parse(raw)).toMatchObject({ code: "internal_error" });
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).not.toContain("SUPABASE_SECRET_KEY");
  });

  it("le RPC retourne autre chose qu'un uuid -> 500 (pas de cookie)", async () => {
    membershipReads.push([]);
    rpc.mockResolvedValue({ data: "not-a-uuid", error: null });
    const res = await POST(req({ name: "A" }));
    expect(res.status).toBe(500);
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("organisation créée mais invisible de l'utilisateur après coup (rejeu après retrait) -> 403 sans journal, pas de cookie", async () => {
    membershipReads.push([], []);
    rpc.mockResolvedValue({ data: ORG, error: null });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await POST(req({ name: "A" }));
    expect(res.status).toBe(403);
    expect(errSpy).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
  });
});

describe("POST /api/orgs : cookie d'organisation active", () => {
  async function succeed() {
    membershipReads.push([], [orgRow]);
    rpc.mockResolvedValue({ data: ORG, error: null });
    return POST(req({ name: "Acme" }));
  }

  it("httpOnly, sameSite=lax, path=/, maxAge=30 jours, valeur = uuid de l'organisation créée", async () => {
    await succeed();
    expect(cookieSet).toHaveBeenCalledTimes(1);
    expect(cookieSet).toHaveBeenCalledWith("fl_active_org", ORG, {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
  });

  it("Secure en production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await succeed();
    expect(cookieSet.mock.calls[0]?.[2]).toMatchObject({ secure: true, httpOnly: true, sameSite: "lax" });
  });

  it.each(["development", "test"])("pas de Secure en %s (http://localhost)", async (env) => {
    vi.stubEnv("NODE_ENV", env);
    await succeed();
    expect(cookieSet.mock.calls[0]?.[2]).toMatchObject({ secure: false });
  });

  it("le cookie n'est pas posé quand la réponse est une erreur", async () => {
    membershipReads.push([]);
    rpc.mockResolvedValue({ data: null, error: { code: "22023", message: "validation_failed" } });
    await POST(req({ name: "A" }));
    expect(cookieSet).not.toHaveBeenCalled();
  });
});

describe("POST /api/orgs : succès et rejeu", () => {
  it("201 puis rejeu de la MÊME clé -> 200 avec le même corps et le même appel RPC (clé identique)", async () => {
    rpc.mockResolvedValue({ data: ORG, error: null });
    membershipReads.push([], [orgRow]);
    const first = await POST(req({ name: "Acme" }));
    membershipReads.push([orgRow], [orgRow]);
    const second = await POST(req({ name: "Acme" }));
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(rpc.mock.calls[0]?.[1]).toEqual(rpc.mock.calls[1]?.[1]);
  });

  it("le corps de succès n'expose que { organization, role } avec les champs publics", async () => {
    membershipReads.push([], [orgRow]);
    rpc.mockResolvedValue({ data: ORG, error: null });
    const body = await (await POST(req({ name: "Acme" }))).json();
    expect(Object.keys(body).sort()).toEqual(["organization", "role"]);
    expect(Object.keys(body.organization).sort()).toEqual(["id", "locale", "name", "slug", "timezone"]);
    expect(body.role).toBe("company_owner");
  });

  it("applique les défauts (locale fr, fuseau UTC) et rogne le nom avant le RPC", async () => {
    membershipReads.push([], [orgRow]);
    rpc.mockResolvedValue({ data: ORG, error: null });
    await POST(req({ name: "  Acme  " }));
    expect(rpc).toHaveBeenCalledWith("create_organization", {
      p_name: "Acme",
      p_locale: "fr",
      p_timezone: "UTC",
      p_creation_key: KEY,
    });
  });

  it.each(["fr", "ar", "en"])("transmet la locale %s au RPC", async (locale) => {
    membershipReads.push([], [orgRow]);
    rpc.mockResolvedValue({ data: ORG, error: null });
    await POST(req({ name: "Acme", locale }));
    expect(rpc).toHaveBeenCalledWith("create_organization", expect.objectContaining({ p_locale: locale }));
  });

  it("le RPC est appelé avec le client de l'utilisateur et aucun identifiant utilisateur en paramètre", async () => {
    membershipReads.push([], [orgRow]);
    rpc.mockResolvedValue({ data: ORG, error: null });
    await POST(req({ name: "Acme" }));
    const params = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(params).some((k) => /user|owner|created_by|org/i.test(k.replace("p_name", "")))).toBe(false);
    expect(JSON.stringify(params)).not.toContain(USER);
  });
});
