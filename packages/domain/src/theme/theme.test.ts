import { describe, expect, it } from "vitest";
import {
  DEFAULT_PALETTE,
  PALETTE_PRESETS,
  PALETTE_TOKENS,
  PRESET_IDS,
  contrastRatio,
  luminance,
  paletteContrastIssues,
  readableTextOn,
  paletteSchema,
  paletteToCss,
  readablePaletteSchema,
  resetPaletteSchema,
  savePaletteSchema,
  type Palette,
} from "../index";

const clone = (p: Palette): Palette => JSON.parse(JSON.stringify(p)) as Palette;

describe("contraste WCAG", () => {
  it("noir sur blanc = 21, identique = 1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });
  it("symétrique", () => {
    expect(contrastRatio("#006a4e", "#ffffff")).toBeCloseTo(contrastRatio("#ffffff", "#006a4e"), 10);
  });
  it("refuse une couleur invalide", () => {
    expect(() => luminance("red")).toThrow();
    expect(() => luminance("#FFFFFF")).toThrow();
  });
});

describe("readableTextOn", () => {
  it("blanc sur fond foncé, quasi noir sur fond clair, toujours AA sur les couleurs vives courantes", () => {
    expect(readableTextOn("#09090b")).toBe("#ffffff");
    expect(readableTextOn("#006a4e")).toBe("#ffffff");
    expect(readableTextOn("#ffffff")).toBe("#09090b");
    expect(readableTextOn("#fb923c")).toBe("#09090b");
    for (const bg of ["#1d4ed8", "#facc15", "#34d399", "#dc2626"]) {
      expect(contrastRatio(readableTextOn(bg), bg)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("presets", () => {
  it.each(PRESET_IDS)("%s : forme valide et contraste AA clair + sombre", (id) => {
    const p = PALETTE_PRESETS[id];
    expect(paletteSchema.safeParse(p).success).toBe(true);
    expect(paletteContrastIssues(p)).toEqual([]);
  });
  it("la palette par défaut est le vert ONMD", () => {
    expect(DEFAULT_PALETTE.light.primary).toBe("#006a4e");
  });
});

describe("paletteSchema", () => {
  it("refuse un jeton inconnu, une couleur non hex, majuscules, #rgb, injection CSS", () => {
    for (const bad of ["red", "#FFF", "#FFFFFF", "#fff", "#12345g", "#ffffff;}body{display:none", "url(javascript:1)", "#ffffff ", ""]) {
      const p = clone(DEFAULT_PALETTE);
      p.light.primary = bad;
      expect(paletteSchema.safeParse(p).success, bad).toBe(false);
    }
    const extra = { ...clone(DEFAULT_PALETTE), light: { ...DEFAULT_PALETTE.light, evil: "#000000" } };
    expect(paletteSchema.safeParse(extra).success).toBe(false);
    expect(paletteSchema.safeParse({ light: DEFAULT_PALETTE.light }).success).toBe(false);
  });
  it("readablePaletteSchema refuse un texte illisible", () => {
    const p = clone(DEFAULT_PALETTE);
    p.light.primary_foreground = "#7fb5a6";
    expect(readablePaletteSchema.safeParse(p).success).toBe(false);
    expect(paletteContrastIssues(p).some((i) => i.text === "primary_foreground" && i.mode === "light")).toBe(true);
  });
});

describe("paletteToCss", () => {
  it("produit :root et .dark avec les variables dérivées, uniquement des hex", () => {
    const css = paletteToCss(PALETTE_PRESETS.blue);
    expect(css.startsWith(":root{")).toBe(true);
    expect(css).toContain(".dark{");
    expect(css).toContain("--primary:#1d4ed8");
    expect(css).toContain("--ring:#1d4ed8");
    expect(css).toContain("--primary:#60a5fa");
    expect(css).toMatch(/^[a-z0-9#:;{}.(), %-]+$/);
    expect(css).toContain("--brand-gradient:linear-gradient(to bottom right,color-mix(in srgb,#1d4ed8 45%,#000000),#1d4ed8,");
    for (const t of PALETTE_TOKENS) expect(typeof PALETTE_PRESETS.blue.light[t]).toBe("string");
  });
  it("jette sur une valeur non hex (jamais écrite en CSS)", () => {
    const p = clone(DEFAULT_PALETTE);
    p.dark.accent = "red;}x{";
    expect(() => paletteToCss(p)).toThrow();
  });
});

describe("savePaletteSchema / resetPaletteSchema", () => {
  const good = JSON.stringify(PALETTE_PRESETS.violet);
  it("accepte une palette JSON valide", () => {
    const r = savePaletteSchema.safeParse({ palette: good });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.palette.light.primary).toBe("#6d28d9");
  });
  it("refuse JSON invalide, trop gros, contraste faible, champ inconnu", () => {
    expect(savePaletteSchema.safeParse({ palette: "{" }).success).toBe(false);
    expect(savePaletteSchema.safeParse({ palette: "x".repeat(5000) }).success).toBe(false);
    const low = clone(PALETTE_PRESETS.blue);
    low.dark.foreground = "#0a0a0c";
    expect(savePaletteSchema.safeParse({ palette: JSON.stringify(low) }).success).toBe(false);
    expect(savePaletteSchema.safeParse({ palette: good, role: "company_owner" }).success).toBe(false);
  });
  it("aucune organisation : un organization_id posté est refusé", () => {
    expect(savePaletteSchema.safeParse({ palette: good, organization_id: "11111111-1111-4111-8111-111111111111" }).success).toBe(false);
    expect(resetPaletteSchema.safeParse({}).success).toBe(true);
    expect(resetPaletteSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});
