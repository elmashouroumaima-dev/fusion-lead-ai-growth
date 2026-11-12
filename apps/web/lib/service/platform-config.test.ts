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

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

describe("getPlatformLogo / getPlatformLogoVersion", async () => {
  const { getPlatformLogo, getPlatformLogoVersion, LOGO_KEY } = await import("./platform-config");

  it("lit le logo par get_platform_config et renvoie type + octets", async () => {
    rpc.mockResolvedValue({ data: { mime: "image/png", data: PNG }, error: null });
    const logo = await getPlatformLogo();
    expect(rpc).toHaveBeenCalledWith("get_platform_config", { p_key: LOGO_KEY });
    expect(logo?.mime).toBe("image/png");
    expect(logo?.bytes[0]).toBe(0x89);
  });

  it("aucune ligne, erreur, type incohérent (SVG déguisé), valeur piégée => null", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(getPlatformLogo()).resolves.toBeNull();
    rpc.mockResolvedValue({ data: null, error: { code: "XX000" } });
    await expect(getPlatformLogo()).resolves.toBeNull();
    rpc.mockResolvedValue({ data: { mime: "image/png", data: btoa("<svg><script>1</script></svg>") }, error: null });
    await expect(getPlatformLogo()).resolves.toBeNull();
    rpc.mockResolvedValue({ data: { mime: "image/svg+xml", data: PNG }, error: null });
    await expect(getPlatformLogo()).resolves.toBeNull();
    createAdminClient.mockImplementationOnce(() => {
      throw new Error("env invalide");
    });
    await expect(getPlatformLogo()).resolves.toBeNull();
  });

  it("version : millisecondes de updated_at, null si absente ou invalide", async () => {
    rpc.mockResolvedValue({ data: "2026-11-07T12:00:00.000Z", error: null });
    await expect(getPlatformLogoVersion()).resolves.toBe(Date.parse("2026-11-07T12:00:00.000Z"));
    expect(rpc).toHaveBeenCalledWith("get_platform_config_updated_at", { p_key: LOGO_KEY });
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(getPlatformLogoVersion()).resolves.toBeNull();
    rpc.mockResolvedValue({ data: "pas une date", error: null });
    await expect(getPlatformLogoVersion()).resolves.toBeNull();
    rpc.mockResolvedValue({ data: "2026-11-07T12:00:00.000Z", error: { code: "XX000" } });
    await expect(getPlatformLogoVersion()).resolves.toBeNull();
  });
});
