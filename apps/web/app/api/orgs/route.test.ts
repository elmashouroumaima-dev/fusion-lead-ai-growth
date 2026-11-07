import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const KEY = "0f8fad5b-d9cb-469f-a165-70867728950e";

const getClaims = vi.fn();
const rpc = vi.fn();
const cookieSet = vi.fn();
/** File de résultats pour les lectures d'adhésions successives (avant / après le RPC). */
const membershipReads: unknown[][] = [];

vi.mock("../../../lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getClaims },
    rpc,
    from: () => {
      // from().select().eq("user_id").eq("status") : le 2e eq() résout avec les lignes.
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
  }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: cookieSet, get: vi.fn() }) }));

// La limitation de débit passe par service_role (J11) : son backend est simulé, jamais appelé ici.
vi.mock("../../../lib/service/rate-limit", () => ({
  LIMITS: {},
  takeToken: async () => ({ allowed: true, retryAfterSeconds: 0 }),
}));

import { POST } from "./route";

const orgRow = {
  organization_id: ORG,
  role: "company_owner",
  organizations: { id: ORG, name: "Acme", slug: "acme-x1", locale: "ar", timezone: "UTC", status: "active" },
};

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/orgs", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": KEY, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  membershipReads.length = 0;
  getClaims.mockResolvedValue({ data: { claims: { sub: USER } }, error: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/orgs", () => {
  it("201 : crée, renvoie organisation + rôle, pose le cookie d'organisation active", async () => {
    membershipReads.push([], [orgRow]);
    rpc.mockResolvedValue({ data: ORG, error: null });
    const res = await POST(req({ name: "  Acme  ", locale: "en", timezone: "Africa/Casablanca" }, { "x-request-id": "req-12345678" }));
    expect(res.status).toBe(201);
    // request_id toujours généré par le serveur : le x-request-id du client n'est jamais repris tel quel.
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(res.headers.get("x-request-id")).not.toBe("req-12345678");
    expect(await res.json()).toEqual({
      organization: { id: ORG, name: "Acme", slug: "acme-x1", locale: "ar", timezone: "UTC" },
      role: "company_owner",
    });
    expect(rpc).toHaveBeenCalledWith("create_organization", {
      p_name: "Acme",
      p_locale: "en",
      p_timezone: "Africa/Casablanca",
      p_creation_key: KEY,
    });
    expect(cookieSet).toHaveBeenCalledWith("fl_active_org", ORG, expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" }));
  });

  it("200 : rejeu de la même clé (organisation déjà connue) -> même corps", async () => {
    membershipReads.push([orgRow], [orgRow]);
    rpc.mockResolvedValue({ data: ORG, error: null });
    const res = await POST(req({ name: "Acme" }));
    expect(res.status).toBe(200);
    expect((await res.json()).organization.id).toBe(ORG);
  });

  it("403 forbidden si organization_id est fourni (même égal à une organisation de l'utilisateur) ; aucun appel RPC", async () => {
    for (const id of [OTHER, ORG, null]) {
      const res = await POST(req({ name: "Acme", organization_id: id }));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "forbidden", request_id: expect.any(String) });
    }
    expect(rpc).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("403 forbidden (pas 500, pas de journal d'erreur) : RPC réussi mais aucune adhésion active ensuite (rejeu après retrait)", async () => {
    membershipReads.push([], []);
    rpc.mockResolvedValue({ data: ORG, error: null });
    const res = await POST(req({ name: "Acme" }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("forbidden");
    expect(console.error).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it.each([
    ["nom de caractères invisibles", { name: "\u200B\u200B" }],
    ["nom contenant un contrôle", { name: "Acme\u0007" }],
    ["nom sans lettre ni chiffre", { name: "---" }],
    ["fuseau en minuscules", { name: "A", timezone: "europe/paris" }],
    ["abréviation de fuseau", { name: "A", timezone: "EST" }],
  ])("400 validation_failed : %s", async (_l, body) => {
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("201 : fuseaux canoniques hors suggestions (Asia/Kolkata, Europe/Kyiv) acceptés", async () => {
    for (const timezone of ["Asia/Kolkata", "Europe/Kyiv"]) {
      membershipReads.push([], [orgRow]);
      rpc.mockResolvedValue({ data: ORG, error: null });
      expect((await POST(req({ name: "Acme", timezone }))).status).toBe(201);
    }
  });

  it("401 sans session ; aucun RPC", async () => {
    getClaims.mockResolvedValue({ data: null, error: null });
    const res = await POST(req({ name: "Acme" }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("unauthenticated");
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["Idempotency-Key absente", { "idempotency-key": "" }, { name: "A" }],
    ["clé trop courte", { "idempotency-key": "short" }, { name: "A" }],
    ["clé avec caractères interdits", { "idempotency-key": "bad key with spaces!" }, { name: "A" }],
    ["content-type incorrect", { "content-type": "text/plain" }, { name: "A" }],
    ["nom vide", {}, { name: "   " }],
    ["nom trop long", {}, { name: "x".repeat(121) }],
    ["locale inconnue", {}, { name: "A", locale: "es" }],
    ["locale en majuscules", {}, { name: "A", locale: "FR" }],
    ["locale avec espace", {}, { name: "A", locale: "fr " }],
    ["fuseau inconnu", {}, { name: "A", timezone: "Mars/Olympus" }],
    ["corps non objet", {}, [1, 2]],
    ["JSON invalide", {}, "{not json"],
  ])("400 validation_failed : %s", async (_label, headers, body) => {
    const res = await POST(req(body, headers));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation_failed");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("422 idempotency_conflict quand la base le signale", async () => {
    membershipReads.push([]);
    rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "idempotency_conflict" } });
    const res = await POST(req({ name: "Autre nom" }));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("idempotency_conflict");
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("500 internal_error sans fuite du message SQL ni de trace", async () => {
    membershipReads.push([]);
    rpc.mockResolvedValue({
      data: null,
      error: { code: "23505", message: 'duplicate key value violates unique constraint "organizations_slug_key"' },
    });
    const res = await POST(req({ name: "Acme" }));
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("duplicate");
    expect(text).not.toContain("organizations_slug_key");
    expect(JSON.parse(text)).toEqual({ code: "internal_error", message: expect.any(String), request_id: expect.any(String) });
  });

  it("journalise sans le nom saisi ni le message SQL", async () => {
    membershipReads.push([]);
    rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "secret detail Acme" } });
    await POST(req({ name: "Acme Confidential" }));
    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).not.toContain("Acme");
    expect(logged).not.toContain("secret detail");
  });
});
