import type { MembersActionErrorCode } from "./types";

/** Forme minimale d'une erreur PostgREST/Postgres : on n'exploite que le SQLSTATE et le message. */
export type DbError = { code?: string | null; message?: string | null } | null | undefined;

/**
 * Traduit une erreur de base en code d'action (les messages bruts ne sortent jamais du serveur).
 *  - 28000 unauthenticated             -> forbidden (la session a expiré : le contexte est revérifié ailleurs)
 *  - 42501 forbidden / RLS             -> forbidden
 *  - 22023 validation_failed           -> invalid_input
 *  - P0001 already_member              -> already_member
 *  - P0001 invitation_invalid          -> invitation_invalid
 *  - P0001 quota_exceeded / subscription_inactive -> quota_exceeded (limite d'utilisateurs du plan, J14)
 *  - P0001 invalid_target              -> invalid_input
 *  - 23514 check_violation             -> last_owner (trigger protect_last_owner)
 *  - tout le reste                     -> generic
 */
export function mapMembersDbError(error: DbError): MembersActionErrorCode {
  const code = error?.code ?? "";
  const message = error?.message ?? "";
  if (code === "42501" || code === "28000") return "forbidden";
  if (code === "22023") return "invalid_input";
  if (code === "23514") return "last_owner";
  if (code === "P0001") {
    if (message.includes("already_member")) return "already_member";
    if (message.includes("invitation_invalid")) return "invitation_invalid";
    if (message.includes("quota_exceeded") || message.includes("subscription_inactive")) return "quota_exceeded";
    if (message.includes("invalid_target")) return "invalid_input";
    if (message.includes("forbidden")) return "forbidden";
  }
  return "generic";
}
