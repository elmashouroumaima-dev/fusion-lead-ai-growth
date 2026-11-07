import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const createClient = vi.fn(async () => ({ rpc }));
vi.mock("../supabase/server", () => ({ createClient: () => createClient() }));

import { getOrganizationUsage } from "./queries";

const ORG = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  rpc.mockReset();
  createClient.mockClear();
});

describe("getOrganizationUsage", () => {
  it("appelle get_org_usage et valide les lignes", async () => {
    const rows = [
      { metric: "users", used: 3, limit: 3, near_limit: true },
      { metric: "projects", used: 0, limit: null, near_limit: false },
    ];
    rpc.mockResolvedValue({ data: rows, error: null });
    await expect(getOrganizationUsage(ORG)).resolves.toEqual(rows);
    expect(rpc).toHaveBeenCalledWith("get_org_usage", { p_org: ORG });
  });

  it("erreur, exception, ligne invalide ou absence de données => liste vide, jamais d'exception", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501" } });
    await expect(getOrganizationUsage(ORG)).resolves.toEqual([]);
    rpc.mockResolvedValue({ data: [{ metric: "inconnue", used: 1, limit: 1, near_limit: false }], error: null });
    await expect(getOrganizationUsage(ORG)).resolves.toEqual([]);
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(getOrganizationUsage(ORG)).resolves.toEqual([]);
    createClient.mockRejectedValueOnce(new Error("boom"));
    await expect(getOrganizationUsage(ORG)).resolves.toEqual([]);
  });
});
