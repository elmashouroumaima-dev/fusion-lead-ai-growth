import type { ServiceErrorCode } from "../service/errors";
import { mapProjectsDbError, type DbError } from "../projects/map-error";

/**
 * Erreur de base d'une fonction `create_contact` / `update_contact` / `record_consent` / `revoke_consent` / `set_do_not_contact`
 * -> code d'API. Comme pour les projets, avec en plus :
 *  - 23505 (index unique : e-mail, téléphone ou identifiant externe déjà pris dans l'entreprise, course comprise) -> conflict ;
 *  - P0001 quota_exceeded -> quota_exceeded (limite « contacts » du plan).
 * Les messages bruts ne sortent jamais du serveur.
 */
export function mapContactsDbError(error: DbError): ServiceErrorCode {
  if ((error?.code ?? "") === "23505") return "conflict";
  // Plafond de consentements par contact : valeur refusée.
  if (error?.code === "P0001" && (error.message ?? "").includes("too_many_consents")) return "validation_failed";
  return mapProjectsDbError(error);
}
