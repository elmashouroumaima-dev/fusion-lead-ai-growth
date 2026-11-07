import { HEX_COLOR, PALETTE_TOKENS, type ModePalette, type Palette, type PaletteToken } from "./palette";

/** Variables CSS pilotées par chaque jeton (les jetons dérivés suivent : carte, fenêtre, barre latérale, anneau...). */
export const TOKEN_CSS_VARIABLES: Record<PaletteToken, readonly string[]> = {
  primary: ["--primary", "--ring", "--sidebar-primary", "--sidebar-ring", "--primary-text-color", "--chart-1"],
  primary_foreground: ["--primary-foreground", "--sidebar-primary-foreground"],
  secondary: ["--secondary", "--chart-2"],
  secondary_foreground: ["--secondary-foreground"],
  background: ["--background", "--card", "--popover", "--sidebar"],
  foreground: ["--foreground", "--card-foreground", "--popover-foreground", "--sidebar-foreground"],
  accent: ["--accent", "--sidebar-accent"],
  accent_foreground: ["--accent-foreground", "--sidebar-accent-foreground"],
  destructive: ["--destructive"],
  destructive_foreground: ["--destructive-foreground"],
};

function declarations(mode: ModePalette): string {
  const out: string[] = [];
  for (const token of PALETTE_TOKENS) {
    const value = mode[token];
    // Défense en profondeur : même validée, une valeur non conforme n'est JAMAIS écrite dans du CSS.
    if (!HEX_COLOR.test(value)) throw new RangeError("invalid_hex");
    for (const variable of TOKEN_CSS_VARIABLES[token]) out.push(`${variable}:${value}`);
  }
  return out.join(";");
}

/**
 * Dégradé de marque des pages publiques (connexion...), dérivé de la couleur principale CLAIRE (texte blanc
 * dessus) : foncé -> principale -> éclaircie. Même dégradé en mode sombre (variable héritée de `:root`).
 * Construit uniquement à partir d'un hex validé.
 */
function brandGradient(primary: string): string {
  if (!HEX_COLOR.test(primary)) throw new RangeError("invalid_hex");
  return `linear-gradient(to bottom right,color-mix(in srgb,${primary} 45%,#000000),${primary},color-mix(in srgb,${primary} 70%,#ffffff))`;
}

/** CSS de la palette : `:root` (clair) puis `.dark` (sombre). N'écrit que des hex validés. */
export function paletteToCss(palette: Palette): string {
  return `:root{${declarations(palette.light)};--brand-gradient:${brandGradient(palette.light.primary)}}.dark{${declarations(palette.dark)}}`;
}
