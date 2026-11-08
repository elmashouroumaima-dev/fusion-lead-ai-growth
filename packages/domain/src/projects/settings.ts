import { z } from "zod";
import { httpsUrlSchema, safeText } from "./text";

/**
 * Réglages (`projects.settings`) par type de projet (spec §4 et §7 : « schéma zod par type », J16). Les champs
 * reprennent le contenu décrit par la spec pour chaque type ; tous sont facultatifs et bornés ; une clé inconnue est
 * REFUSÉE (objets stricts). La base n'impose qu'un objet de 32 Ko au plus : ces schémas sont la seule validation de forme.
 * Les captures d'écran d'un thème (Storage) viendront avec le J17.
 */

export const PROJECT_TYPES = ["website_sales", "salla_app", "salla_theme", "custom"] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];
export const projectTypeSchema = z.enum(PROJECT_TYPES);

const short = (max = 200) => safeText(1, max);
const long = (max = 1000) => safeText(1, max, true);
const list = <T extends z.ZodType>(item: T, max: number) => z.array(item).max(max);

/** § 4.1 — vente de sites : offres et formules, modèles d'affaires, marché cible, questions de qualification, pages d'atterrissage. */
export const websiteSalesSettingsSchema = z
  .object({
    offers: list(short(200), 20).optional(),
    business_models: list(short(100), 10).optional(),
    target_market: short(200).optional(),
    qualification_questions: list(short(300), 20).optional(),
    landing_pages: list(z.object({ name: short(100), url: httpsUrlSchema }).strict(), 20).optional(),
  })
  .strict();

/** § 4.2 — application Salla : nom, problème résolu, segments de marchands, lien du store, activation, prix de test, FAQ. */
export const sallaAppSettingsSchema = z
  .object({
    app_name: short(120).optional(),
    problem_solved: long(1000).optional(),
    merchant_segments: list(short(100), 20).optional(),
    store_url: httpsUrlSchema.optional(),
    activation_flow: long(1000).optional(),
    test_pricing: short(200).optional(),
    faqs: list(z.object({ question: short(300), answer: long(1000) }).strict(), 30).optional(),
  })
  .strict();

/** § 4.3 — thème Salla : lien d'aperçu, secteurs adaptés, avantages, scénarios publicitaires. */
export const sallaThemeSettingsSchema = z
  .object({
    preview_url: httpsUrlSchema.optional(),
    sectors: list(short(100), 20).optional(),
    features: list(short(200), 30).optional(),
    ad_scenarios: list(short(300), 20).optional(),
  })
  .strict();

/** Projet « autre » (§ 4.4) : notes libres et champs nommés, bornés (clé en minuscules, valeur courte). */
export const CUSTOM_FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;
export const customSettingsSchema = z
  .object({
    notes: long(2000).optional(),
    fields: z
      .record(z.string().regex(CUSTOM_FIELD_KEY), short(500))
      .refine((record) => Object.keys(record).length <= 20, { message: "too_many_fields" })
      .optional(),
  })
  .strict();

export type WebsiteSalesSettings = z.infer<typeof websiteSalesSettingsSchema>;
export type SallaAppSettings = z.infer<typeof sallaAppSettingsSchema>;
export type SallaThemeSettings = z.infer<typeof sallaThemeSettingsSchema>;
export type CustomSettings = z.infer<typeof customSettingsSchema>;
export type ProjectSettings = WebsiteSalesSettings | SallaAppSettings | SallaThemeSettings | CustomSettings;

export const PROJECT_SETTINGS_SCHEMAS = {
  website_sales: websiteSalesSettingsSchema,
  salla_app: sallaAppSettingsSchema,
  salla_theme: sallaThemeSettingsSchema,
  custom: customSettingsSchema,
} as const satisfies Record<ProjectType, z.ZodType>;

/** Valide (et normalise : textes rognés) les réglages d'un projet selon son type. */
export function parseProjectSettings(type: ProjectType, value: unknown) {
  return PROJECT_SETTINGS_SCHEMAS[type].safeParse(value ?? {});
}
