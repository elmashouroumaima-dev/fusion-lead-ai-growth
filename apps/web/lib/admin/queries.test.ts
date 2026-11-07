import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const createClient = vi.fn(async () => ({ rpc }));
vi.mock("../supabase/server", () => ({ createClient: () => createClient() }));

import { isPlatformAdmin, listAdminOrganizations } from "./queries";

const ROW = {
  organization_id: "11111111-1111-4111-8111-111111111111",
  name: "Alpha",
  slug: "alpha",
  org_status: "active",
  plan_code: "trial",
  sub_status: "trial",
  period_end: null,
  limits_override: {},
  members: 3,
  created_at: "2026-11-07T12:00:00Z",
};

beforeEach(() => {
  rpc.mockReset();
  createClient.mockClear();
});

describe("isPlatformAdmin", () => {
  it("true seulement si la base répond exactement true", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    await expect(isPlatformAdmin()).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith("is_platform_admin");
  });

  it("false, valeur inattendue, erreur ou exception => false (jamais de droit deviné)", async () => {
    for (const data of [false, null, "true", 1]) {
      rpc.mockResolvedValue({ data, error: null });
      await expect(isPlatformAdmin()).resolves.toBe(false);
    }
    rpc.mockResolvedValue({ data: true, error: { code: "XX000" } });
    await expect(isPlatformAdmin()).resolves.toBe(false);
    createClient.mockRejectedValueOnce(new Error("boom"));
    await expect(isPlatformAdmin()).resolves.toBe(false);
  });
});

describe("listAdminOrganizations", () => {
  it("appelle admin_list_organizations et valide chaque ligne", async () => {
    rpc.mockResolvedValue({ data: [ROW], error: null });
    await expect(listAdminOrganizations(50, 10)).resolves.toEqual([ROW]);
    expect(rpc).toHaveBeenCalledWith("admin_list_organizations", { p_limit: 50, p_offset: 10 });
  });

  it("liste vide si la base ne renvoie rien ; erreur ou ligne invalide => exception générique", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(listAdminOrganizations()).resolves.toEqual([]);
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "forbidden secret" } });
    await expect(listAdminOrganizations()).rejects.toThrow("admin_organizations_lookup_failed");
    rpc.mockResolvedValue({ data: [{ ...ROW, sub_status: "gratuit" }], error: null });
    await expect(listAdminOrganizations()).rejects.toThrow("admin_organizations_lookup_failed");
  });
});
