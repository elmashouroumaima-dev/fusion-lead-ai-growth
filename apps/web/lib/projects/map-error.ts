import type { ServiceErrorCode } from "../service/errors";

/** Forme minimale d'une erreur PostgREST/Postgres : on n'exploite que le SQLSTATE et le message. */
export type DbError = { code?: string | null; message?: string | null } | null | undefined;

/**
 * Traduit une erreur de base (fonctions `create_project`, `update_project`, `set_project_status`, `create_product`,
 * `update_product`) en code d'API. Les messages bruts ne sortent jamais du serveur.
 *  - 28000 unauthenticated                              -> unauthenticated
 *  - 42501 forbidden / RLS                              -> forbidden
 *  - 22023 validation_failed, 23514 contrainte, 23503 FK -> validation_failed
 *  - PT404 not_found (HTTP 404 côté PostgREST)          -> not_found
 *  - P0001 project_archived                             -> conflict (projet archivé : lecture seule)
 *  - P0001 owner_invalid                                -> validation_failed (propriétaire non membre actif)
 *  - P0001 quota_exceeded / subscription_inactive       -> quota_exceeded (limite de projets du plan)
 *  - tout le reste                                      -> internal_error
 */
export function mapProjectsDbError(error: DbError): ServiceErrorCode {
  const code = error?.code ?? "";
  const message = error?.message ?? "";
  if (code === "28000" || code === "PGRST301" || code === "PGRST303") return "unauthenticated";
  if (code === "42501") return "forbidden";
  if (code === "22023" || code === "23514" || code === "23503") return "validation_failed";
  if (code === "PT404" || code === "P0002") return "not_found";
  if (code === "P0001") {
    if (message.includes("project_archived")) return "conflict";
    if (message.includes("owner_invalid")) return "validation_failed";
    if (message.includes("quota_exceeded") || message.includes("subscription_inactive")) return "quota_exceeded";
    if (message.includes("not_found")) return "not_found";
    if (message.includes("forbidden")) return "forbidden";
  }
  return "internal_error";
}
