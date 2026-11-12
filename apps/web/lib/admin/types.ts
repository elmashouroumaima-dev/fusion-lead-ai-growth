/** Types partagés des actions d'administration (type-only : importés par des composants client). */

export type AdminActionErrorCode =
  | "invalid_input"
  | "forbidden"
  | "rate_limited"
  | "duplicate_request"
  | "idempotency_in_progress"
  | "idempotency_conflict"
  | "service_unavailable"
  | "generic";

/** État renvoyé aux formulaires : des codes uniquement, jamais de texte (traduit par l'interface). */
export type AdminActionState = {
  status: "idle" | "error" | "success";
  code?: AdminActionErrorCode;
  fieldErrors?: Record<string, string[]>;
};
