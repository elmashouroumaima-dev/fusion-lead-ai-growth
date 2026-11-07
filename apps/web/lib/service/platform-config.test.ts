import { PALETTE_PRESETS } from "@fusion-leap/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const rpc = vi.fn();
const createAdminClient = vi.fn(() => ({ rpc }));
vi.mock("../supabase/admin", () => ({ createAdminClient: () => createAdminClient() }));

import { getPlatformPalette, PALETTE_KEY } from "./platform-config";

beforeEach(() => {
  rpc.mockReset();
  createAdminClient.mockClear();
});

describe("getPlatformPalette", () => {
  it("appelle uniquement get_platform_config avec la clé de la palette", async () => {
    rpc.mockResolvedValue({ data: PALETTE_PRESETS.blue, error: null });
    await expect(getPlatformPalette()).resolves.toEqual(PALETTE_PRESETS.blue);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("get_platform_config", { p_key: PALETTE_KEY });
  });

  it("aucune ligne, erreur de lecture, exception => null", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(getPlatformPalette()).resolves.toBeNull();
    rpc.mockResolvedValue({ data: null, error: { code: "XX000" } });
    await expect(getPlatformPalette()).resolves.toBeNull();
    createAdminClient.mockImplementationOnce(() => {
      throw new Error("env invalide");
    });
    await expect(getPlatformPalette()).resolves.toBeNull();
  });

  it("valeur illisible ou piégée => null (jamais écrite en CSS)", async () => {
    const evil = JSON.parse(JSON.stringify(PALETTE_PRESETS.blue)) as typeof PALETTE_PRESETS.blue;
    evil.light.primary = "red;}body{display:none";
    rpc.mockResolvedValue({ data: evil, error: null });
    await expect(getPlatformPalette()).resolves.toBeNull();
    rpc.mockResolvedValue({ data: "nope", error: null });
    await expect(getPlatformPalette()).resolves.toBeNull();
  });
});
