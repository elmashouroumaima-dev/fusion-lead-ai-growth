import { z } from "zod";
import { uuidSchema } from "../tenant/schemas";
import {
  customSettingsSchema,
  sallaAppSettingsSchema,
  sallaThemeSettingsSchema,
  websiteSalesSettingsSchema,
  projectTypeSchema,
} from "./settings";
import { httpsUrlSchema, safeText } from "./text";

/**
 * Schémas des projets et produits (J16, spec §7 et §8, ADR 007). Source unique pour les Server Actions, la route
 * `POST /api/projects` et la lecture des lignes renvoyées par la base.
 */

export const PROJECT_STATUSES = ["active", "archived"] as const;
export const projectStatusSchema = z.enum(PROJECT_STATUSES);
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_NAME_MAX = 120;
export const PRODUCT_KIND_MAX = 50;
export const PRODUCT_OFFER_MAX = 500;
export const PRODUCT_PRICE_HINT_MAX = 100;
export const PRODUCT_ASSETS_MAX = 50;

/**
 * `organization_id` éventuellement posté par l'interface : jamais une source de vérité, seulement comparé au contexte
 * vérifié (assertSameOrganization). Absent = rien de revendiqué.
 */
const claimedOrganization = uuidSchema.optional();

const projectName = safeText(1, PROJECT_NAME_MAX);
const ownerId = uuidSchema.nullable().optional();

const projectBase = { name: projectName, owner_id: ownerId, organization_id: claimedOrganization };

/**
 * Création d'un projet : le type choisit le schéma des réglages. Les réglages sont validés ICI (la base ne contrôle que
 * l'objet et sa taille).
 */
export const createProjectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("website_sales"), settings: websiteSalesSettingsSchema.default({}), ...projectBase }).strict(),
  z.object({ type: z.literal("salla_app"), settings: sallaAppSettingsSchema.default({}), ...projectBase }).strict(),
  z.object({ type: z.literal("salla_theme"), settings: sallaThemeSettingsSchema.default({}), ...projectBase }).strict(),
  z.object({ type: z.literal("custom"), settings: customSettingsSchema.default({}), ...projectBase }).strict(),
]);
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

/**
 * Modification : le type n'est pas modifiable ; la forme des réglages dépend du type du projet, lu en base par le service
 * (`parseProjectSettings`). Ici, objet quelconque.
 */
export const updateProjectSchema = z
  .object({
    project_id: uuidSchema,
    name: projectName,
    settings: z.record(z.string(), z.unknown()).default({}),
    owner_id: ownerId,
    organization_id: claimedOrganization,
  })
  .strict();
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const setProjectStatusSchema = z
  .object({ project_id: uuidSchema, status: projectStatusSchema, organization_id: claimedOrganization })
  .strict();
export type SetProjectStatusInput = z.infer<typeof setProjectStatusSchema>;

/** Chemin Storage d'un asset : `{organisation}/{projet}/{fichier}` (miroir de `private.is_valid_product_assets`). */
const ASSET_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z0-9._/-]{1,200}$/;
export const assetPathSchema = z
  .string()
  .regex(ASSET_PATH)
  .refine((path) => !path.includes("..") && !path.includes("//"), { message: "invalid_path" });

const productFields = {
  kind: safeText(1, PRODUCT_KIND_MAX),
  offer: safeText(1, PRODUCT_OFFER_MAX, true),
  price_hint: safeText(1, PRODUCT_PRICE_HINT_MAX).nullable().optional(),
  landing_url: httpsUrlSchema.nullable().optional(),
  assets: z.array(assetPathSchema).max(PRODUCT_ASSETS_MAX).default([]),
  organization_id: claimedOrganization,
};

export const createProductSchema = z.object({ project_id: uuidSchema, ...productFields }).strict();
export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = z.object({ product_id: uuidSchema, ...productFields }).strict();
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

// --- Lignes renvoyées par la base (lecture) ---
export const projectRowSchema = z.object({
  id: uuidSchema,
  organization_id: uuidSchema,
  type: projectTypeSchema,
  name: z.string(),
  status: projectStatusSchema,
  owner_id: uuidSchema.nullable(),
  settings: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ProjectRow = z.infer<typeof projectRowSchema>;

export const productRowSchema = z.object({
  id: uuidSchema,
  organization_id: uuidSchema,
  project_id: uuidSchema,
  kind: z.string(),
  offer: z.string(),
  price_hint: z.string().nullable(),
  landing_url: z.string().nullable(),
  assets: z.array(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ProductRow = z.infer<typeof productRowSchema>;
