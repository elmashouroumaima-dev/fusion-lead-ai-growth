import { z } from "zod";

/** Jetons modifiables (liste blanche, identique à la contrainte SQL private.is_valid_palette). */
export const PALETTE_TOKENS = [
  "primary",
  "primary_foreground",
  "secondary",
  "secondary_foreground",
  "background",
  "foreground",
  "accent",
  "accent_foreground",
  "destructive",
  "destructive_foreground",
] as const;
export type PaletteToken = (typeof PALETTE_TOKENS)[number];

export const PALETTE_MODES = ["light", "dark"] as const;
export type PaletteMode = (typeof PALETTE_MODES)[number];

/** Couleur #rrggbb en minuscules uniquement : jamais de chaîne libre qui finirait dans du CSS. */
export const HEX_COLOR = /^#[0-9a-f]{6}$/;
export const hexColorSchema = z.string().regex(HEX_COLOR);

export type ModePalette = Record<PaletteToken, string>;
export type Palette = Record<PaletteMode, ModePalette>;

/** Paires (texte, fond) qui doivent atteindre le ratio WCAG AA 4.5:1. */
export const CONTRAST_PAIRS: ReadonlyArray<readonly [PaletteToken, PaletteToken]> = [
  ["foreground", "background"],
  ["primary_foreground", "primary"],
  ["primary", "background"], // --primary sert aussi de texte (liens, boutons fantômes)
  ["secondary_foreground", "secondary"],
  ["accent_foreground", "accent"],
  ["destructive_foreground", "destructive"],
];
export const MIN_CONTRAST = 4.5;

const tokenShape = Object.fromEntries(PALETTE_TOKENS.map((t) => [t, hexColorSchema])) as Record<PaletteToken, typeof hexColorSchema>;
const modeSchema = z.object(tokenShape).strict();

/** Forme d'une palette COMPLÈTE (clair + sombre). Le contraste est vérifié par `paletteContrastIssues`. */
export const paletteSchema = z.object({ light: modeSchema, dark: modeSchema }).strict();
