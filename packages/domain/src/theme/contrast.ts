import { CONTRAST_PAIRS, HEX_COLOR, MIN_CONTRAST, PALETTE_MODES, type Palette, type PaletteMode, type PaletteToken } from "./palette";

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Luminance relative WCAG d'une couleur #rrggbb. */
export function luminance(hex: string): number {
  if (!HEX_COLOR.test(hex)) throw new RangeError("invalid_hex");
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Ratio de contraste WCAG (1 à 21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export type ContrastIssue = { mode: PaletteMode; text: PaletteToken; background: PaletteToken; ratio: number };

/** Paires sous le seuil AA (4.5:1). Liste vide = palette acceptable. */
export function paletteContrastIssues(palette: Palette): ContrastIssue[] {
  const issues: ContrastIssue[] = [];
  for (const mode of PALETTE_MODES) {
    for (const [text, background] of CONTRAST_PAIRS) {
      const ratio = contrastRatio(palette[mode][text], palette[mode][background]);
      if (ratio < MIN_CONTRAST) issues.push({ mode, text, background, ratio: Math.round(ratio * 100) / 100 });
    }
  }
  return issues;
}
