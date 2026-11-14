import type { ServiceErrorCode } from "../service/errors";
import type { ActivitiesActionErrorCode } from "./types";

/** Code de la couche service -> code d'état de formulaire (traduit par l'interface). */
export function toActionCode(code: ServiceErrorCode): ActivitiesActionErrorCode {
  switch (code) {
    case "validation_failed":
    case "payload_too_large":
      return "invalid_input";
    case "forbidden":
    case "unauthenticated":
      return "forbidden";
    case "quota_exceeded":
    case "conflict":
    case "not_found":
    case "rate_limited":
    case "duplicate_request":
    case "idempotency_in_progress":
    case "idempotency_conflict":
    case "service_unavailable":
      return code;
    default:
      return "generic";
  }
}
