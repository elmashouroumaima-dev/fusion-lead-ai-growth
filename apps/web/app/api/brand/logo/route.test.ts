import { beforeEach, describe, expect, it, vi } from "vitest";

const getPlatformLogo = vi.fn();
vi.mock("../../../../lib/service/platform-config", () => ({ getPlatformLogo: () => getPlatformLogo() }));

import { GET } from "./route";

beforeEach(() => getPlatformLogo.mockReset());

describe("GET /api/brand/logo", () => {
  it("sert les octets avec le type DÉTECTÉ et des en-têtes restrictifs", async () => {
    getPlatformLogo.mockResolvedValue({ mime: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("content-length")).toBe("8");
    expect(new Uint8Array(await res.arrayBuffer())[0]).toBe(0x89);
  });

  it("aucun logo => 404 sans corps, sans cache", async () => {
    getPlatformLogo.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("");
  });
});
