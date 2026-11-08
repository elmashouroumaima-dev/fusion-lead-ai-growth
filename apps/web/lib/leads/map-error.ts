import type { ServiceErrorCode } from "../service/errors";
import { mapProjectsDbError, type DbError } from "../projects/map-error";

/**
 * Erreur de base d'une fonction de pipeline, d'étape, de lead ou de deal -> code d'API. Comme pour les projets
 * (`project_archived` -> conflict, 22023 / 23514 / 23503 -> validation_failed, PT404 -> not_found, 42501 -> forbidden), avec en plus :
 *  - 23505 (nom de pipeline ou d'étape déjà pris, identifiant externe déjà utilisé) -> conflict ;
 *  - P0001 assignee_invalid -> validation_failed (le responsable doit être un membre actif owner, admin ou commercial) ;
 *  - 23502 (valeur obligatoire absente) -> validation_failed ;
 *  - P0001 pipeline_incomplete, stage_in_use, system_stage, last_open_stage, plafonds techniques (pipelines, étapes, leads par contact,
 *    deals par lead) -> conflict.
 * Les messages bruts ne sortent jamais du serveur.
 */
const CONFLICTS = [
  "pipeline_incomplete",
  "stage_in_use",
  "system_stage",
  "last_open_stage",
  "too_many_pipelines",
  "too_many_stages",
  "too_many_leads",
  "too_many_deals",
] as const;

export function mapLeadsDbError(error: DbError): ServiceErrorCode {
  const code = error?.code ?? "";
  const message = error?.message ?? "";
  if (code === "23505") return "conflict";
  // valeur obligatoire absente (NOT NULL) : donnée invalide
  if (code === "23502") return "validation_failed";
  if (code === "P0001") {
    if (message.includes("assignee_invalid")) return "validation_failed";
    if (CONFLICTS.some((reason) => message.includes(reason))) return "conflict";
  }
  return mapProjectsDbError(error);
}
