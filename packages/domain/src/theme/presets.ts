import type { Palette } from "./palette";

const neutralLight = { background: "#ffffff", foreground: "#09090b", accent: "#f4f4f5", accent_foreground: "#18181b" } as const;
const neutralDark = { background: "#09090b", foreground: "#ffffff", accent: "#27272a", accent_foreground: "#fafafa" } as const;

function preset(lightPrimary: string, darkPrimary: string, lightSecondary = "#ae2b2f"): Palette {
  return {
    light: {
      ...neutralLight,
      primary: lightPrimary,
      primary_foreground: "#ffffff",
      secondary: lightSecondary,
      secondary_foreground: "#ffffff",
      destructive: "#dc2626",
      destructive_foreground: "#ffffff",
    },
    dark: {
      ...neutralDark,
      primary: darkPrimary,
      primary_foreground: "#09090b",
      secondary: "#ae2b2f",
      secondary_foreground: "#ffffff",
      destructive: "#b91c1c",
      destructive_foreground: "#ffffff",
    },
  };
}

export const PRESET_IDS = ["green", "blue", "violet", "orange"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

/** Palettes proposées (toutes conformes au contraste AA, vérifié par test). `green` = couleurs ONMD d'origine. */
export const PALETTE_PRESETS: Record<PresetId, Palette> = {
  green: preset("#006a4e", "#34d399"),
  blue: preset("#1d4ed8", "#60a5fa"),
  violet: preset("#6d28d9", "#a78bfa"),
  orange: preset("#c2410c", "#fb923c"),
};
export const DEFAULT_PALETTE: Palette = PALETTE_PRESETS.green;
