import { z } from "zod";
import { paletteContrastIssues } from "./contrast";
import { paletteSchema, type Palette } from "./palette";

/** Palette complète ET lisible (contraste AA sur toutes les paires). */
export const readablePaletteSchema = paletteSchema.refine((p) => paletteContrastIssues(p).length === 0, {
  message: "contrast_too_low",
});

const MAX_PALETTE_JSON = 4096;

/** Le formulaire envoie la palette en JSON (champ caché) : analysé et validé ici, jamais fait confiance. */
const paletteJson = z
  .string()
  .max(MAX_PALETTE_JSON)
  .transform((raw, ctx): Palette => {
    try {
      const parsed = readablePaletteSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      /* JSON invalide : traité comme entrée invalide ci-dessous */
    }
    ctx.addIssue({ code: "custom", message: "invalid_palette" });
    return z.NEVER;
  });

export const savePaletteSchema = z.object({ palette: paletteJson }).strict();
export type SavePaletteInput = z.infer<typeof savePaletteSchema>;

export const resetPaletteSchema = z.object({}).strict();
export type ResetPaletteInput = z.infer<typeof resetPaletteSchema>;
