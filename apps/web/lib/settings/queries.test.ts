import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const createClient = vi.fn(async () => ({ rpc }));
vi.mock("../supabase/server", () => ({ createClient: () => createClient() }));

import { canManagePlatformConfig } from "./queries";

beforeEach(() => {
  rpc.mockReset();
  createClient.mockClear();
});

describe("canManagePlatformConfig", () => {
  it("true seulement si la base répond exactement true", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    await expect(canManagePlatformConfig()).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith("can_manage_platform_config");
  });

  it("false, null, valeur inattendue ou erreur => false (jamais de droit deviné)", async () => {
    for (const data of [false, null, "true", 1, {}]) {
      rpc.mockResolvedValue({ data, error: null });
      await expect(canManagePlatformConfig()).resolves.toBe(false);
    }
    rpc.mockResolvedValue({ data: true, error: { code: "XX000" } });
    await expect(canManagePlatformConfig()).resolves.toBe(false);
    createClient.mockRejectedValueOnce(new Error("boom"));
    await expect(canManagePlatformConfig()).resolves.toBe(false);
  });
});
