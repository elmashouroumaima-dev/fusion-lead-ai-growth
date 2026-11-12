import { describe, expect, it } from "vitest";
import { MAX_LOGO_BYTES, decodeBase64, detectImageMime, logoSchema, resetLogoSchema, saveLogoSchema } from "../index";

// PNG 1x1 valide.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const b64 = (bytes: number[]): string => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};
const JPEG = b64([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = b64([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50]);
const SVG = btoa("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
const HTML = btoa("<html><script>alert(1)</script></html>");

describe("detectImageMime", () => {
  it("reconnaît PNG, JPEG et WebP par leurs octets", () => {
    expect(detectImageMime(decodeBase64(PNG)!)).toBe("image/png");
    expect(detectImageMime(decodeBase64(JPEG)!)).toBe("image/jpeg");
    expect(detectImageMime(decodeBase64(WEBP)!)).toBe("image/webp");
  });
  it("refuse SVG, HTML, vide et RIFF non WebP", () => {
    expect(detectImageMime(decodeBase64(SVG)!)).toBeNull();
    expect(detectImageMime(decodeBase64(HTML)!)).toBeNull();
    expect(detectImageMime(new Uint8Array())).toBeNull();
    expect(detectImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBeNull();
  });
});

describe("decodeBase64", () => {
  it("refuse caractères hors alphabet, longueur non multiple de 4, trop court, trop long", () => {
    expect(decodeBase64("abc$defg")).toBeNull();
    expect(decodeBase64("abcdefg")).toBeNull();
    expect(decodeBase64("abcd")).toBeNull();
    expect(decodeBase64("A".repeat(174768))).toBeNull();
    expect(decodeBase64("iVBO\nRw0K")).toBeNull();
  });
});

describe("logoSchema", () => {
  it("accepte un PNG, un JPEG et un WebP dont le type correspond aux octets", () => {
    expect(logoSchema.safeParse({ mime: "image/png", data: PNG }).success).toBe(true);
    expect(logoSchema.safeParse({ mime: "image/jpeg", data: JPEG }).success).toBe(true);
    expect(logoSchema.safeParse({ mime: "image/webp", data: WEBP }).success).toBe(true);
  });
  it("refuse un type annoncé différent des octets (SVG/HTML déguisés, PNG annoncé JPEG)", () => {
    expect(logoSchema.safeParse({ mime: "image/png", data: SVG }).success).toBe(false);
    expect(logoSchema.safeParse({ mime: "image/png", data: HTML }).success).toBe(false);
    expect(logoSchema.safeParse({ mime: "image/jpeg", data: PNG }).success).toBe(false);
  });
  it("refuse SVG annoncé, champ en trop, trop gros", () => {
    expect(logoSchema.safeParse({ mime: "image/svg+xml", data: SVG }).success).toBe(false);
    expect(logoSchema.safeParse({ mime: "image/png", data: PNG, extra: 1 }).success).toBe(false);
    const big = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(MAX_LOGO_BYTES).fill(0)]);
    expect(logoSchema.safeParse({ mime: "image/png", data: big }).success).toBe(false);
  });
});

describe("saveLogoSchema / resetLogoSchema", () => {
  it("accepte un logo JSON valide, refuse JSON invalide, trop gros ou champ inconnu", () => {
    expect(saveLogoSchema.safeParse({ logo: JSON.stringify({ mime: "image/png", data: PNG }) }).success).toBe(true);
    expect(saveLogoSchema.safeParse({ logo: "{" }).success).toBe(false);
    expect(saveLogoSchema.safeParse({ logo: "x".repeat(180000) }).success).toBe(false);
    expect(saveLogoSchema.safeParse({ logo: JSON.stringify({ mime: "image/png", data: SVG }) }).success).toBe(false);
    expect(saveLogoSchema.safeParse({ logo: JSON.stringify({ mime: "image/png", data: PNG }), organization_id: "x" }).success).toBe(false);
  });
  it("reset : aucun champ", () => {
    expect(resetLogoSchema.safeParse({}).success).toBe(true);
    expect(resetLogoSchema.safeParse({ a: 1 }).success).toBe(false);
  });
});
