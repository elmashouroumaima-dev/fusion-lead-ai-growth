import { z } from "zod";
import { uuidSchema } from "../tenant/schemas";

/**
 * Liste des leads (J24) : paramètres d'URL -> filtres validés, et lignes de `search_leads`. Fonctions PURES : une valeur invalide est
 * IGNORÉE (retour au défaut), jamais transmise telle quelle ; la base re-contrôle tout.
 */
export const LEADS_PAGE_SIZE = 25;
export const LEADS_MAX_PAGE = 4000;
export const LEADS_EXPORT_MAX_ROWS = 10_000;
export const LEAD_SORTS = ["created_desc", "created_asc", "updated_desc", "name_asc"] as const;
export type LeadSort = (typeof LEAD_SORTS)[number];
export const LEAD_SEARCH_MAX_LENGTH = 100;

export type LeadListFilters = {
  project: string | null;
  stage: string | null;
  source: string | null;
  assignee: string | null;
  unassigned: boolean;
  query: string | null;
  sort: LeadSort;
};

export type LeadListParams = { filters: LeadListFilters; page: number };

type RawParams = Record<string, string | string[] | undefined> | URLSearchParams;

function first(raw: RawParams, key: string): string | null {
  if (raw instanceof URLSearchParams) return raw.get(key);
  const value = raw[key];
  const one = Array.isArray(value) ? value[0] : value;
  return typeof one === "string" ? one : null;
}

const optionalUuid = (value: string | null): string | null => {
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** Texte de recherche : espaces de bordure retirés, contrôles et caractères invisibles supprimés, 100 caractères au plus. */
export function cleanSearchQuery(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length === 0 ? null : cleaned.slice(0, LEAD_SEARCH_MAX_LENGTH);
}

export function parseLeadListParams(raw: RawParams): LeadListParams {
  const source = first(raw, "source");
  const sort = first(raw, "sort");
  const page = Number(first(raw, "page"));
  return {
    filters: {
      project: optionalUuid(first(raw, "project")),
      stage: optionalUuid(first(raw, "stage")),
      source: source !== null && /^[a-z][a-z0-9_]{0,49}$/.test(source) ? source : null,
      assignee: optionalUuid(first(raw, "assignee")),
      unassigned: first(raw, "unassigned") === "1",
      query: cleanSearchQuery(first(raw, "q")),
      sort: (LEAD_SORTS as readonly string[]).includes(sort ?? "") ? (sort as LeadSort) : "created_desc",
    },
    page: Number.isInteger(page) && page >= 1 ? Math.min(page, LEADS_MAX_PAGE) : 1,
  };
}

/**
 * Vrai si un paramètre de filtre est PRÉSENT mais invalide (UUID mal formé, source ou tri inconnus). La liste l'ignore (retour au
 * défaut) ; l'EXPORT le refuse : un lien d'export mal formé ne doit pas exporter tout sans le dire.
 */
export function hasInvalidLeadListParams(raw: RawParams): boolean {
  const present = (key: string): string | null => {
    const value = first(raw, key);
    return value === null || value === "" ? null : value;
  };
  for (const key of ["project", "stage", "assignee"]) {
    const value = present(key);
    if (value !== null && optionalUuid(value) === null) return true;
  }
  const source = present("source");
  if (source !== null && !/^[a-z][a-z0-9_]{0,49}$/.test(source)) return true;
  const sort = present("sort");
  if (sort !== null && !(LEAD_SORTS as readonly string[]).includes(sort)) return true;
  const unassigned = present("unassigned");
  return unassigned !== null && unassigned !== "1";
}

/** Paramètres d'URL d'une liste (valeurs par défaut omises) ; sert aux liens de pagination, de filtre et d'export. */
export function leadListQuery(filters: LeadListFilters, page = 1): string {
  const params = new URLSearchParams();
  if (filters.project) params.set("project", filters.project);
  if (filters.stage) params.set("stage", filters.stage);
  if (filters.source) params.set("source", filters.source);
  if (filters.assignee) params.set("assignee", filters.assignee);
  if (filters.unassigned) params.set("unassigned", "1");
  if (filters.query) params.set("q", filters.query);
  if (filters.sort !== "created_desc") params.set("sort", filters.sort);
  if (page > 1) params.set("page", String(page));
  return params.toString();
}

/** NOMS des filtres actifs (jamais leurs valeurs) : c'est tout ce que l'audit d'un export conserve. */
export function activeFilterNames(filters: LeadListFilters): Record<string, true> {
  const names: Record<string, true> = {};
  if (filters.project) names.project = true;
  if (filters.stage) names.stage = true;
  if (filters.source) names.source = true;
  if (filters.assignee) names.assignee = true;
  if (filters.unassigned) names.unassigned = true;
  if (filters.query) names.query = true;
  if (filters.sort !== "created_desc") names.sort = true;
  return names;
}

/** Ligne renvoyée par `search_leads`. */
export const leadListRowSchema = z.object({
  id: uuidSchema,
  contact_id: uuidSchema,
  project_id: uuidSchema,
  source: z.string(),
  stage_id: uuidSchema,
  stage_name: z.string(),
  stage_kind: z.enum(["open", "won", "lost", "unassigned"]),
  assignee_id: uuidSchema.nullable(),
  score: z.number().int().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  contact_name: z.string().nullable(),
  contact_email: z.string().nullable(),
  contact_phone: z.string().nullable(),
  total_count: z.union([z.number(), z.string()]).transform((value) => Number(value)),
});
export type LeadListRow = z.output<typeof leadListRowSchema>;
