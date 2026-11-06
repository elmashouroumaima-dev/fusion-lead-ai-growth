import type { ApiErrorCode } from "./errors";

/** Forme minimale d'une erreur PostgREST / supabase-js (seuls `code` et `message` sont lus). */
export type DbErrorLike = { code?: string | null | undefined; message?: string | null | undefined };

/**
 * Traduit une erreur de la base en code d'API. Fonction pure : seul un ensemble fermé de
 * signatures est reconnu (contrat de private.create_organization) ; tout le reste devient
 * `internal_error`, sans jamais exposer le message SQL.
 *
 *  - 'unauthenticated'      (SQLSTATE 28000)
 *  - 'validation_failed'    (SQLSTATE 22023, ainsi que 22P05 et 22021 : texte non encodable)
 *  - 'idempotency_conflict' (SQLSTATE P0001)
 *  - 42501 insufficient_privilege (GRANT/RLS)  -> forbidden
 *  - PGRST301 / PGRST303 (JWT invalide ou expiré) -> unauthenticated
 */
export function mapDbError(error: DbErrorLike | null | undefined): ApiErrorCode {
  if (!error) return "internal_error";
  const message = (error.message ?? "").trim();
  const code = error.code ?? "";

  if (message === "idempotency_conflict" && code === "P0001") return "idempotency_conflict";
  if (message === "validation_failed" && (code === "22023" || code === "")) return "validation_failed";
  if (message === "unauthenticated" && (code === "28000" || code === "")) return "unauthenticated";

  // 22023 invalid_parameter_value ; 22P05 untranslatable_character ; 22021 character_not_in_repertoire
  if (code === "22023" || code === "22P05" || code === "22021") return "validation_failed";
  if (code === "28000" || code === "PGRST301" || code === "PGRST303") return "unauthenticated";
  if (code === "42501") return "forbidden";
  return "internal_error";
}
