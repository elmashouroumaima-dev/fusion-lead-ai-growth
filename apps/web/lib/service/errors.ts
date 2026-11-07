import { REQUEST_ID_HEADER } from "./request-id";

/**
 * Codes stables de l'API (ADR 006). Jamais de détail interne ni de donnée sensible dans le corps.
 *
 * `duplicate_request` : rejeu d'une requête déjà traitée dont la réponse n'est volontairement pas
 * conservée (secrets, ex. jeton d'invitation) : l'effet a eu lieu, le corps ne sera pas rejoué.
 */
export type ServiceErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "validation_failed"
  | "not_found"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "duplicate_request"
  | "rate_limited"
  | "payload_too_large"
  | "quota_exceeded"
  | "service_unavailable"
  | "internal_error";

/** Table unique code -> statut HTTP. */
const STATUS: Record<ServiceErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  validation_failed: 400,
  not_found: 404,
  idempotency_conflict: 422,
  idempotency_in_progress: 409,
  duplicate_request: 409,
  rate_limited: 429,
  payload_too_large: 413,
  quota_exceeded: 429,
  service_unavailable: 503,
  internal_error: 500,
};

/** Messages génériques et stables (anglais, destinés aux développeurs ; l'UI traduit les codes). */
const MESSAGE: Record<ServiceErrorCode, string> = {
  unauthenticated: "Authentication is required.",
  forbidden: "You are not allowed to perform this action.",
  validation_failed: "The request is invalid.",
  not_found: "The requested resource was not found.",
  idempotency_conflict: "This Idempotency-Key was already used with different parameters.",
  idempotency_in_progress: "A request with this Idempotency-Key is still being processed.",
  duplicate_request: "This request was already processed; its response is not replayed.",
  rate_limited: "Too many requests. Please retry later.",
  payload_too_large: "The request body is too large.",
  quota_exceeded: "The quota of your plan has been reached.",
  service_unavailable: "The service is temporarily unavailable.",
  internal_error: "An unexpected error occurred.",
};

export type ServiceErrorOptions = {
  retryAfterSeconds?: number;
  /** Noms de champs et codes de validation uniquement (jamais les valeurs saisies) ; réservé aux Server Actions. */
  fieldErrors?: Record<string, string[]>;
};

/** Erreur métier/technique attendue du pipeline. Le message est toujours le texte générique du code. */
export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly status: number;
  readonly retryAfterSeconds?: number;
  readonly fieldErrors?: Record<string, string[]>;

  constructor(code: ServiceErrorCode, options: ServiceErrorOptions = {}) {
    super(MESSAGE[code]);
    this.name = "ServiceError";
    this.code = code;
    this.status = STATUS[code];
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
    if (options.fieldErrors !== undefined) this.fieldErrors = options.fieldErrors;
  }
}

export type ApiErrorBody = { code: ServiceErrorCode; message: string; request_id: string };

export type NormalizedError = {
  status: number;
  body: ApiErrorBody;
  headers: Record<string, string>;
};

export const serviceErrorStatus = (code: ServiceErrorCode): number => STATUS[code];

/**
 * Normalise n'importe quelle erreur en `{ status, body: { code, message, request_id }, headers }`.
 * Le texte d'une erreur inconnue n'est JAMAIS recopié : tout ce qui n'est pas une `ServiceError`
 * devient `internal_error`.
 */
export function normalizeError(error: unknown, requestId: string): NormalizedError {
  const known = error instanceof ServiceError ? error : undefined;
  const code: ServiceErrorCode = known?.code ?? "internal_error";
  const headers: Record<string, string> = {
    [REQUEST_ID_HEADER]: requestId,
    "cache-control": "no-store",
  };
  if (known?.retryAfterSeconds !== undefined && Number.isInteger(known.retryAfterSeconds) && known.retryAfterSeconds > 0) {
    headers["retry-after"] = String(known.retryAfterSeconds);
  }
  // Rejet d'un rejeu dont la réponse n'est pas conservée : le client doit savoir que l'effet a déjà eu lieu.
  if (code === "duplicate_request") headers["idempotent-replay"] = "true";
  return { status: STATUS[code], body: { code, message: MESSAGE[code], request_id: requestId }, headers };
}

/** Réponse d'erreur normalisée, avec `x-request-id` en écho. */
export function errorResponse(error: unknown, requestId: string): Response {
  const { status, body, headers } = normalizeError(error, requestId);
  return Response.json(body, { status, headers });
}
