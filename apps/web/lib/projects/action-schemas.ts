import {
  createProductSchema,
  createProjectSchema,
  removeAssetSchema,
  setProjectStatusSchema,
  updateProductSchema,
  updateProjectSchema,
  uploadAssetSchema,
  type CreateProductInput,
  type CreateProjectInput,
  type RemoveAssetInput,
  type SetProjectStatusInput,
  type UpdateProductInput,
  type UpdateProjectInput,
  type UploadAssetInput,
} from "@fusion-leap/domain";
import type { ServiceSchema } from "../service/with-service";

/**
 * Schémas des Server Actions Projets : les champs de formulaire (tous des textes) deviennent les entrées des schémas métier
 * du domaine. Les réglages et les assets voyagent en JSON dans un champ caché ; un JSON illisible est REFUSÉ (jamais
 * remplacé par un objet vide). `organization_id` n'est jamais une vérité : le pipeline le compare au contexte vérifié.
 */

type Raw = Record<string, string | undefined>;

/** Marqueur d'un JSON illisible : aucun schéma ne l'accepte. */
const INVALID_JSON: unique symbol = Symbol("invalid-json");

/** Profondeur maximale acceptée pour un JSON de formulaire (les réglages légitimes en ont 3 au plus ; la base en tolère 4). */
const MAX_JSON_DEPTH = 6;

/** Profondeur d'imbrication d'un texte JSON, calculée SANS le décoder (jamais de récursion sur une entrée hostile). */
export function jsonNestingDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{" || char === "[") {
      depth += 1;
      if (depth > max) max = depth;
      if (max > MAX_JSON_DEPTH) return max;
    } else if (char === "}" || char === "]") depth -= 1;
  }
  return max;
}

/**
 * Décode un champ JSON : trop profond, illisible ou portant une clé `__proto__` (qui se comporterait comme un prototype et
 * échapperait aux schémas stricts) -> marqueur refusé par tout schéma.
 */
function parseJson(value: string | undefined, whenMissing: unknown): unknown {
  if (value === undefined || value === "") return whenMissing;
  if (jsonNestingDepth(value) > MAX_JSON_DEPTH) return INVALID_JSON;
  try {
    return JSON.parse(value, (key, parsed: unknown) => {
      if (key === "__proto__") throw new Error("forbidden_key");
      return parsed;
    }) as unknown;
  } catch {
    return INVALID_JSON;
  }
}

const blankToNull = (value: string | undefined): string | null => (value === undefined || value.trim() === "" ? null : value);
const blankToUndefined = (value: string | undefined): string | undefined => (value === undefined || value === "" ? undefined : value);

type Parsed<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: ReadonlyArray<{ code: string; path: PropertyKey[] }> } };

function through<T>(build: (raw: Raw) => unknown, schema: { safeParse(input: unknown): Parsed<T> }): ServiceSchema<T> {
  return { safeParse: (raw) => schema.safeParse(build(raw as Raw)) };
}

export const createProjectFormSchema: ServiceSchema<CreateProjectInput> = through(
  (r) => ({ type: r.type, name: r.name, settings: parseJson(r.settings, {}), organization_id: blankToUndefined(r.organization_id) }),
  createProjectSchema,
);

export const updateProjectFormSchema: ServiceSchema<UpdateProjectInput> = through(
  (r) => ({ project_id: r.project_id, name: r.name, settings: parseJson(r.settings, {}), organization_id: blankToUndefined(r.organization_id) }),
  updateProjectSchema,
);

export const setProjectStatusFormSchema: ServiceSchema<SetProjectStatusInput> = through(
  (r) => ({ project_id: r.project_id, status: r.status, organization_id: blankToUndefined(r.organization_id) }),
  setProjectStatusSchema,
);

const productFields = (r: Raw) => ({
  kind: r.kind,
  offer: r.offer,
  price_hint: blankToNull(r.price_hint),
  landing_url: blankToNull(r.landing_url),
  // Les fichiers ne passent plus par ce formulaire (revue J17) : jamais de liste venue du client ; ils se gèrent par
  // l'envoi / le retrait (fonctions SQL atomiques).
  assets: [],
  organization_id: blankToUndefined(r.organization_id),
});

export const createProductFormSchema: ServiceSchema<CreateProductInput> = through(
  (r) => ({ project_id: r.project_id, ...productFields(r) }),
  createProductSchema,
);

export const updateProductFormSchema: ServiceSchema<UpdateProductInput> = through(
  (r) => ({ product_id: r.product_id, ...productFields(r) }),
  updateProductSchema,
);

export const uploadAssetFormSchema: ServiceSchema<UploadAssetInput> = through(
  (r) => ({ product_id: r.product_id, organization_id: blankToUndefined(r.organization_id) }),
  uploadAssetSchema,
);

export const removeAssetFormSchema: ServiceSchema<RemoveAssetInput> = through(
  (r) => ({ product_id: r.product_id, path: r.path, organization_id: blankToUndefined(r.organization_id) }),
  removeAssetSchema,
);

export const PROJECT_FORM_FIELDS = ["type", "name", "settings", "organization_id"] as const;
export const PROJECT_UPDATE_FIELDS = ["project_id", "name", "settings", "organization_id"] as const;
export const PROJECT_STATUS_FIELDS = ["project_id", "status", "organization_id"] as const;
export const PRODUCT_CREATE_FIELDS = ["project_id", "kind", "offer", "price_hint", "landing_url", "assets", "organization_id"] as const;
export const ASSET_UPLOAD_FIELDS = ["product_id", "organization_id"] as const;
export const ASSET_REMOVE_FIELDS = ["product_id", "path", "organization_id"] as const;
export const PRODUCT_UPDATE_FIELDS = ["product_id", "kind", "offer", "price_hint", "landing_url", "assets", "organization_id"] as const;
