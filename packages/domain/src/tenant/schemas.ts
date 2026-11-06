import { z } from "zod";
import { localeSchema } from "../auth/schemas";

/**
 * Schémas du contexte tenant et de la création d'organisation (J9, ADR 005 §7 et §11).
 * Source unique pour les Server Actions, la route POST /api/orgs et la lecture des lignes
 * renvoyées par la base (aucune donnée de la base n'est consommée sans passer par zod).
 */

/** Valeurs de l'enum Postgres `app_role` (ADR 006). `platform_admin` n'en fait pas partie. */
export const APP_ROLES = [
  "company_owner",
  "company_admin",
  "marketing_manager",
  "sales_agent",
  "analyst",
] as const;
export const tenantRoleSchema = z.enum(APP_ROLES);
export type TenantRole = z.infer<typeof tenantRoleSchema>;

/** Valeurs de l'enum Postgres `org_status`. */
export const ORG_STATUSES = ["active", "suspended", "closed"] as const;
export const orgStatusSchema = z.enum(ORG_STATUSES);
export type OrgStatus = z.infer<typeof orgStatusSchema>;

export const ORGANIZATION_NAME_MAX = 120;
export const IDEMPOTENCY_KEY_MIN = 8;
export const IDEMPOTENCY_KEY_MAX = 128;

/**
 * Identifiant d'organisation / d'utilisateur. `z.guid()` (forme 8-4-4-4-12) plutôt que `z.uuid()`
 * strict : les identifiants viennent de gen_random_uuid() (v4), mais les jeux de données de test
 * peuvent en utiliser qui ne respectent pas les bits de version/variante RFC.
 */
export const uuidSchema = z.guid();

/** Valeur du cookie `fl_active_org` : un simple indice, jamais une preuve (ADR 005 §7). */
export const activeOrgCookieSchema = uuidSchema;

/** Clé d'idempotence (en-tête `Idempotency-Key` ou champ caché du formulaire d'onboarding). */
export const idempotencyKeySchema = z
  .string()
  .min(IDEMPOTENCY_KEY_MIN)
  .max(IDEMPOTENCY_KEY_MAX)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * Fuseaux IANA proposés par l'environnement d'exécution, pour SUGGESTIONS d'interface uniquement
 * (liste déroulante). La validation ne dépend PAS de cette liste : voir `isValidTimeZone`.
 * `Intl.supportedValuesOf` omet « UTC » : on l'ajoute (défaut de la colonne et de la fonction SQL).
 */
export const SUPPORTED_TIME_ZONES: readonly string[] = Object.freeze(
  [...new Set(["UTC", ...Intl.supportedValuesOf("timeZone")])].sort((a, b) => a.localeCompare(b)),
);

/** Forme région/ville (casse respectée) ; « UTC » est traité à part. Même règle que la base. */
const TIME_ZONE_SHAPE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/;

let lowerCaseSuggestions: Map<string, string> | undefined;
function suggestionsByLowerCase(): Map<string, string> {
  lowerCaseSuggestions ??= new Map(SUPPORTED_TIME_ZONES.map((zone) => [zone.toLowerCase(), zone]));
  return lowerCaseSuggestions;
}

/**
 * Fuseau accepté ssi « UTC », ou forme région/ville ET connu du moteur (construction d'un
 * `Intl.DateTimeFormat`). `Intl` ignore la casse alors que la base (pg_timezone_names) la
 * respecte : une variante qui ne diffère d'un nom connu que par la casse est refusée.
 * Les noms canoniques absents de la liste de suggestions (Asia/Kolkata, Europe/Kyiv) sont acceptés.
 */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === "UTC") return true;
  if (!TIME_ZONE_SHAPE.test(value)) return false;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return false;
  }
  const lower = value.toLowerCase();
  if (resolved.toLowerCase() === lower && resolved !== value) return false;
  const known = suggestionsByLowerCase().get(lower);
  if (known !== undefined) return known === value;
  // Nom valide mais absent des suggestions (ex. alias : Asia/Kolkata alors que le moteur liste
  // Asia/Calcutta) : la casse ne peut pas être comparée à une liste. Garde-fou de forme (chaque
  // segment commence par une majuscule, aucun mot de 4 lettres ou plus tout en capitales) ;
  // la base reste l'autorité (comparaison exacte à pg_timezone_names).
  return value.split("/").every((segment) => {
    const letters = segment.replace(/[^A-Za-z]/g, "");
    return /^[A-Z]/.test(segment) && !(letters.length >= 4 && letters === letters.toUpperCase());
  });
}

export const timezoneSchema = z
  .string()
  .refine((value) => isValidTimeZone(value), { message: "invalid_timezone" });

/**
 * Caractères interdits dans un nom : contrôles C0/C1, invisibles et formats bidi, séparateurs de
 * ligne/paragraphe. Même liste que la contrainte SQL.
 */
const FORBIDDEN_NAME_CHARS =
  // eslint-disable-next-line no-control-regex -- les contrôles sont précisément ce que ce motif doit refuser
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\u061C\uFEFF]/u;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Nom rogné : 1..120 caractères, au moins une lettre ou un chiffre, sans caractère interdit. */
export const organizationNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(ORGANIZATION_NAME_MAX)
  .refine((value) => !FORBIDDEN_NAME_CHARS.test(value), { message: "forbidden_characters" })
  .refine((value) => HAS_LETTER_OR_DIGIT.test(value), { message: "no_letter_or_digit" });

const createOrganizationShape = {
  name: organizationNameSchema,
  locale: localeSchema.default("ar"),
  timezone: timezoneSchema.default("UTC"),
};

/** Tolérant aux champs inconnus (ils sont ignorés) : Server Action et formulaires. */
export const createOrganizationSchema = z.object(createOrganizationShape);
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

/** Variante stricte pour l'API publique : tout champ inconnu est refusé. */
export const createOrganizationApiSchema = z.object(createOrganizationShape).strict();

/** Organisation telle qu'exposée à l'interface et à l'API (aucun champ interne). */
export const organizationSummarySchema = z.object({
  id: uuidSchema,
  name: z.string(),
  slug: z.string(),
  locale: localeSchema,
  timezone: z.string(),
});
export type OrganizationSummary = z.infer<typeof organizationSummarySchema>;

/**
 * Ligne `organization_members` + organisation imbriquée, lue avec les droits de l'utilisateur
 * (RLS). PostgREST renvoie un objet pour une relation many-to-one ; un tableau d'un élément est
 * toléré par prudence.
 */
const embeddedOrganizationSchema = z.preprocess(
  (value) => (Array.isArray(value) ? (value.length === 1 ? value[0] : null) : value),
  organizationSummarySchema.extend({ status: orgStatusSchema }).nullable(),
);

export const membershipRowSchema = z.object({
  organization_id: uuidSchema,
  role: tenantRoleSchema,
  organizations: embeddedOrganizationSchema,
});
export type MembershipRow = z.infer<typeof membershipRowSchema>;
