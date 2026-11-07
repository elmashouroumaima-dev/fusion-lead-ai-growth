import { REQUEST_ID_HEADER } from "./request-id";

/** Codes stables de l'API (ADR 006). Jamais de détail interne ni de donnée sensible dans le corps. */
export type ApiErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "validation_failed"
  | "idempotency_conflict"
  | "payload_too_large"
  | "internal_error";

export type ApiErrorBody = { code: ApiErrorCode; message: string; request_id: string };

const STATUS: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  validation_failed: 400,
  idempotency_conflict: 422,
  payload_too_large: 413,
  internal_error: 500,
};

/** Messages génériques et stables (anglais, destinés aux développeurs ; l'UI traduit les codes). */
const MESSAGE: Record<ApiErrorCode, string> = {
  unauthenticated: "Authentication is required.",
  forbidden: "You are not allowed to perform this action.",
  validation_failed: "The request is invalid.",
  idempotency_conflict: "This Idempotency-Key was already used with different parameters.",
  payload_too_large: "The request body is too large.",
  internal_error: "An unexpected error occurred.",
};

export const apiErrorStatus = (code: ApiErrorCode): number => STATUS[code];

export function apiErrorBody(code: ApiErrorCode, requestId: string): ApiErrorBody {
  return { code, message: MESSAGE[code], request_id: requestId };
}

/** Réponse d'erreur normalisée `{ code, message, request_id }`, avec `x-request-id` en écho. */
export function apiError(code: ApiErrorCode, requestId: string): Response {
  return Response.json(apiErrorBody(code, requestId), {
    status: STATUS[code],
    headers: { [REQUEST_ID_HEADER]: requestId, "cache-control": "no-store" },
  });
}
