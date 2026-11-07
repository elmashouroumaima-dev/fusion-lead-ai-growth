import { beforeEach, describe, expect, it, vi } from "vitest";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const getClaims = vi.fn();
const getSession = vi.fn();
const getUser = vi.fn();
const eq = vi.fn();
const select = vi.fn();
const from = vi.fn();
const cookieGet = vi.fn();

vi.mock("../supabase/server", () => ({
  createClient: async () => ({ auth: { getClaims, getSession, getUser }, from }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: cookieGet }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));

import { assertSameOrganization, getTenantContext, TenantError, type TenantContext } from "./context";

const row = (id: string, role: string, status = "active") => ({
  organization_id: id,
  role,
  organizations: { id, name: "Org", slug: "org", locale: "ar", timezone: "UTC", status },
});

/** from().select().eq("user_id").eq("status") : le second eq() résout. Les filtres sont enregistrés. */
function setRows(rows: unknown[]) {
  eq.mockReset();
  eq.mockReturnValueOnce({ eq }).mockResolvedValueOnce({ data: rows, error: null });
  select.mockReturnValue({ eq });
  from.mockReturnValue({ select });
}

beforeEach(() => {
  vi.clearAllMocks();
  getClaims.mockResolvedValue({ data: { claims: { sub: USER } }, error: null });
  cookieGet.mockReturnValue(undefined);
});

describe("getTenantContext : le cookie n'est jamais une preuve", () => {
  it("avec un cookie, la lecture des adhésions a quand même lieu, pour l'utilisateur des claims", async () => {
    cookieGet.mockReturnValue({ value: A });
    setRows([row(A, "analyst")]);
    await getTenantContext();
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("organization_members");
    expect(eq).toHaveBeenCalledWith("user_id", USER);
    expect(eq).toHaveBeenCalledWith("status", "active");
  });

  it("l'identifiant utilisateur vient du claim sub, jamais du cookie ni d'un autre champ", async () => {
    getClaims.mockResolvedValue({
      data: { claims: { sub: USER, user_id: B, email: "x@y.z", user_metadata: { user_id: B } } },
      error: null,
    });
    cookieGet.mockReturnValue({ value: B });
    setRows([row(B, "analyst")]);
    await getTenantContext();
    expect(eq).toHaveBeenCalledWith("user_id", USER);
    expect(eq).not.toHaveBeenCalledWith("user_id", B);
  });

  // Adhésion invited / suspended / removed : la requête filtre status = 'active', la base ne renvoie rien.
  it.each(["invited", "suspended", "removed"])(
    "cookie vers une organisation où mon adhésion est %s (aucune ligne active) -> forbidden",
    async () => {
      cookieGet.mockReturnValue({ value: A });
      setRows([]);
      await expect(getTenantContext()).rejects.toMatchObject({ code: "forbidden" });
      expect(eq).toHaveBeenCalledWith("status", "active");
    },
  );

  it("cookie vers l'organisation d'un autre utilisateur (jamais renvoyée par la RLS) -> forbidden", async () => {
    cookieGet.mockReturnValue({ value: B });
    setRows([row(A, "company_owner")]);
    const err = await getTenantContext().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TenantError);
    expect((err as TenantError).code).toBe("forbidden");
  });

  it("un cookie sans adhésion ne retombe PAS silencieusement sur l'unique adhésion existante", async () => {
    cookieGet.mockReturnValue({ value: B });
    setRows([row(A, "company_owner")]);
    await expect(getTenantContext()).rejects.toMatchObject({ code: "forbidden" });
  });

  it("cookie vers une organisation suspendue -> organization_inactive (pas de contexte)", async () => {
    cookieGet.mockReturnValue({ value: A });
    setRows([row(A, "company_owner", "suspended")]);
    await expect(getTenantContext()).rejects.toMatchObject({ code: "organization_inactive" });
  });

  it("base en échec avec un cookie présent -> erreur, jamais un contexte déduit du cookie", async () => {
    cookieGet.mockReturnValue({ value: A });
    eq.mockReset();
    eq.mockReturnValueOnce({ eq }).mockResolvedValueOnce({ data: null, error: { message: "down" } });
    select.mockReturnValue({ eq });
    from.mockReturnValue({ select });
    await expect(getTenantContext()).rejects.toThrow("membership_lookup_failed");
  });
});

describe("getTenantContext : le rôle vient de la base, jamais des claims", () => {
  it("ignore role / app_role / user_metadata / app_metadata présents dans le JWT", async () => {
    getClaims.mockResolvedValue({
      data: {
        claims: {
          sub: USER,
          role: "authenticated",
          app_role: "company_owner",
          user_metadata: { role: "company_owner", organization_id: B },
          app_metadata: { role: "company_owner", organization_id: B },
        },
      },
      error: null,
    });
    setRows([row(A, "analyst")]);
    const ctx = await getTenantContext();
    expect(ctx.role).toBe("analyst");
    expect(ctx.organizationId).toBe(A);
  });

  it("un organization_id présent dans les claims n'oriente pas le choix de l'organisation", async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: USER, organization_id: B } }, error: null });
    setRows([row(A, "sales_agent")]);
    await expect(getTenantContext()).resolves.toMatchObject({ organizationId: A, role: "sales_agent" });
  });

  it("n'utilise ni getSession() ni getUser() (identité = claims vérifiés uniquement)", async () => {
    setRows([row(A, "analyst")]);
    await getTenantContext();
    expect(getSession).not.toHaveBeenCalled();
    expect(getUser).not.toHaveBeenCalled();
    expect(getClaims).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["sub absent", { claims: {} }],
    ["sub non uuid", { claims: { sub: "admin" } }],
    ["sub numérique", { claims: { sub: 1 } }],
    ["claims null", { claims: null }],
  ])("%s -> unauthenticated, sans lecture en base", async (_l, data) => {
    getClaims.mockResolvedValue({ data, error: null });
    await expect(getTenantContext()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(from).not.toHaveBeenCalled();
  });

  it("getClaims en erreur (JWT invalide ou expiré) -> unauthenticated même avec un cookie", async () => {
    cookieGet.mockReturnValue({ value: A });
    getClaims.mockResolvedValue({ data: { claims: { sub: USER } }, error: new Error("jwt expired") });
    await expect(getTenantContext()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(from).not.toHaveBeenCalled();
  });

  it.each(["company_owner", "company_admin", "marketing_manager", "sales_agent", "analyst"] as const)(
    "rôle %s de la ligne d'adhésion reflété tel quel",
    async (role) => {
      setRows([row(A, role)]);
      await expect(getTenantContext()).resolves.toMatchObject({ role });
    },
  );

  it("ne renvoie que les champs publics (pas de status ni de champ interne)", async () => {
    setRows([row(A, "analyst")]);
    const ctx = await getTenantContext();
    expect(Object.keys(ctx.organization).sort()).toEqual(["id", "locale", "name", "slug", "timezone"]);
    expect(Object.keys(ctx).sort()).toEqual(["organization", "organizationId", "role", "userId"]);
  });
});

describe("assertSameOrganization : variantes", () => {
  const ctx: TenantContext = {
    userId: USER,
    organizationId: A,
    role: "analyst",
    organization: { id: A, name: "x", slug: "x", locale: "ar", timezone: "UTC" },
  };
  const code = (claimed: unknown): string | undefined => {
    try {
      assertSameOrganization(ctx, claimed);
    } catch (e) {
      return (e as TenantError).code;
    }
    return undefined;
  };

  it("identique ou casse différente -> passe (uuid insensibles à la casse)", () => {
    expect(code(A)).toBeUndefined();
    expect(code(A.toUpperCase())).toBeUndefined();
  });
  it.each([
    ["autre organisation", B],
    ["espace avant", ` ${A}`],
    ["espace après", `${A} `],
    ["retour ligne", `${A}\n`],
    ["suffixe", `${A}x`],
    ["préfixe", `x${A}`],
    ["sans tirets", A.replaceAll("-", "")],
    ["chaîne vide", ""],
    ["null", null],
    ["nombre", 1],
    ["booléen", true],
    ["objet", { id: A }],
    ["tableau", [A]],
  ])("refuse : %s -> forbidden", (_l, claimed) => {
    expect(code(claimed)).toBe("forbidden");
  });
  it("undefined = rien de revendiqué (seul cas toléré hors égalité)", () => {
    expect(code(undefined)).toBeUndefined();
  });
  it("l'erreur est une TenantError", () => {
    expect(() => assertSameOrganization(ctx, B)).toThrow(TenantError);
  });
});
