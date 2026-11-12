import type { ServiceErrorCode } from "../service/errors";
import { mapLeadsDbError } from "../leads/map-error";
import type { DbError } from "../projects/map-error";

/**
 * Erreur de base d'une fonction d'activité -> code d'API. Comme pour les leads (`project_archived` et doublons -> conflict,
 * `assignee_invalid` et valeurs invalides -> validation_failed, PT404 -> not_found, 42501 -> forbidden, `subscription_inactive`
 * -> quota_exceeded), avec en plus `too_many_activities` (plafond technique de 500 par lead) -> conflict. Les messages bruts ne
 * sortent jamais du serveur.
 */
export function mapActivitiesDbError(error: DbError): ServiceErrorCode {
  if (error?.code === "P0001" && (error.message ?? "").includes("too_many_activities")) return "conflict";
  return mapLeadsDbError(error);
}
