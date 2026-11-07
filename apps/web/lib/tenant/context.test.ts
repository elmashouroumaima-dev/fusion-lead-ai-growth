import { beforeEach, describe, expect, it, vi } from "vitest";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const getClaims = vi.fn();
const query = { select: vi.fn(), eq: vi.fn() };
const from = vi.fn();
const cookieGet = vi.fn();

vi.mock("../supabase/server", () => ({ createClient: async () => ({ auth: { getClaims }, from }) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: cookieGet }) }));
class RedirectSignal extends Error {
  constructor(public readonly url: string) {
    super("NEXT_REDIRECT");
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));

import { assertSameOrganization, getTenantContext, requireTenantContext, TenantError } from "./context";

const row = (id: string, role: string, status = "active") => ({
  organization_id: id,
  role,
  organizations: { id, name: `Org ${id.slice(0, 1)}`, slug: `org-${id.slice(0, 1)}`, locale: "ar", timezone: "UTC", status },
});

/** Chaîne from().select().eq().eq() : le second eq() résout avec les lignes. */
function setRows(rows: unknown[], error: unknown = null) {
  query.select.mockReturnValue(query);
  query.eq.mockReset();
  query.eq.mockReturnValueOnce(query).mockResolvedValueOnce({ data: rows, error });
  from.mockReturnValue(query);
}

beforeEach(() => {
  vi.clearAllMocks();
  getClaims.mockResolvedValue({ data: { claims: { sub: USER } }, error: null });
  cookieGet.mockReturnValue(undefined);
});

describe("getTenantContext", () => {
  it("sans session -> unauthenticated, sans toucher à la base", async () => {
    getClaims.mockResolvedValue({ data: null, error: new Error("x") });
    await expect(getTenantContext()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(from).not.toHaveBeenCalled();
  });

  it("relit l'adhésion en base, filtrée sur l'utilisateur et le statut active", async () => {
    setRows([row(A, "analyst")]);
    const ctx = await getTenantContext();
    expect(ctx).toMatchObject({ userId: USER, organizationId: A, role: "analyst" });
    expect(from).toHaveBeenCalledWith("organization_members");
    expect(query.eq).toHaveBeenCalledWith("user_id", USER);
    expect(query.eq).toHaveBeenCalledWith("status", "active");
  });

  it("deux appels = deux lectures (aucun cache) ; un rôle rétrogradé est vu immédiatement", async () => {
    setRows([row(A, "company_admin")]);
    expect((await getTenantContext()).role).toBe("company_admin");
    setRows([row(A, "analyst")]);
    expect((await getTenantContext()).role).toBe("analyst");
    expect(from).toHaveBeenCalledTimes(2);
  });

  it("un cookie vers une organisation sans adhésion -> forbidden", async () => {
    cookieGet.mockReturnValue({ value: B });
    setRows([row(A, "company_owner")]);
    await expect(getTenantContext()).rejects.toMatchObject({ code: "forbidden" });
  });

  it("un cookie qui n'est pas un uuid est ignoré (traité comme absent)", async () => {
    cookieGet.mockReturnValue({ value: "x'; drop table y;--" });
    setRows([row(A, "company_owner")]);
    await expect(getTenantContext()).resolves.toMatchObject({ organizationId: A });
  });

  it("plusieurs adhésions et cookie valide -> la bonne organisation et le rôle de CETTE adhésion", async () => {
    cookieGet.mockReturnValue({ value: B });
    setRows([row(A, "company_owner"), row(B, "sales_agent")]);
    await expect(getTenantContext()).resolves.toMatchObject({ organizationId: B, role: "sales_agent" });
  });

  it("organisation suspendue -> organization_inactive", async () => {
    setRows([row(A, "company_owner", "suspended")]);
    await expect(getTenantContext()).rejects.toMatchObject({ code: "organization_inactive" });
  });

  it("organisation masquée par la RLS (organizations null) -> aucune organisation", async () => {
    setRows([{ organization_id: A, role: "analyst", organizations: null }]);
    await expect(getTenantContext()).rejects.toMatchObject({ code: "no_organization" });
  });

  it("erreur de base ou ligne illisible -> erreur générique (pas un rôle deviné)", async () => {
    setRows([], { message: "boom" });
    await expect(getTenantContext()).rejects.toThrow("membership_lookup_failed");
    setRows([{ organization_id: A, role: "root", organizations: null }]);
    await expect(getTenantContext()).rejects.toThrow("membership_lookup_failed");
  });
});

describe("requireTenantContext", () => {
  it("aucune organisation -> /en/onboarding", async () => {
    setRows([]);
    await expect(requireTenantContext("en")).rejects.toMatchObject({ url: "/en/onboarding" });
  });
  it("plusieurs organisations sans cookie -> /en/select-organization", async () => {
    setRows([row(A, "analyst"), row(B, "analyst")]);
    await expect(requireTenantContext("en")).rejects.toMatchObject({ url: "/en/select-organization" });
  });
  it("cookie sans adhésion (ancienne organisation) -> /en/select-organization", async () => {
    cookieGet.mockReturnValue({ value: B });
    setRows([row(A, "analyst")]);
    await expect(requireTenantContext("en")).rejects.toMatchObject({ url: "/en/select-organization" });
  });
  it("organisation fermée -> /en/select-organization", async () => {
    setRows([row(A, "analyst", "closed")]);
    await expect(requireTenantContext("en")).rejects.toMatchObject({ url: "/en/select-organization" });
  });
  it("non authentifié -> /{locale}/login ; locale invalide -> locale par défaut (fr)", async () => {
    getClaims.mockResolvedValue({ data: null, error: null });
    await expect(requireTenantContext("ar")).rejects.toMatchObject({ url: "/ar/login" });
    await expect(requireTenantContext("fr")).rejects.toMatchObject({ url: "/fr/login" });
    await expect(requireTenantContext("en")).rejects.toMatchObject({ url: "/en/login" });
    await expect(requireTenantContext("xx")).rejects.toMatchObject({ url: "/fr/login" });
  });
  it("retourne le contexte quand tout est valide", async () => {
    setRows([row(A, "marketing_manager")]);
    await expect(requireTenantContext("en")).resolves.toMatchObject({ organizationId: A, role: "marketing_manager" });
  });
  it("propage une erreur inattendue (pas de redirection silencieuse)", async () => {
    setRows([], { message: "boom" });
    await expect(requireTenantContext("en")).rejects.toThrow("membership_lookup_failed");
  });
});

describe("assertSameOrganization", () => {
  const ctx = {
    userId: USER,
    organizationId: A,
    role: "analyst" as const,
    organization: { id: A, name: "x", slug: "x", locale: "ar" as const, timezone: "UTC" },
  };
  it("accepte l'identifiant du contexte (casse ignorée) ou rien", () => {
    expect(() => assertSameOrganization(ctx, A)).not.toThrow();
    expect(() => assertSameOrganization(ctx, A.toUpperCase())).not.toThrow();
    expect(() => assertSameOrganization(ctx, undefined)).not.toThrow();
  });
  it.each([[B], [null], [123], [{ id: A }], [""], [[A]]])("refuse %j avec le code forbidden", (claimed) => {
    let caught: unknown;
    try {
      assertSameOrganization(ctx, claimed);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TenantError);
    expect((caught as TenantError).code).toBe("forbidden");
  });
});
