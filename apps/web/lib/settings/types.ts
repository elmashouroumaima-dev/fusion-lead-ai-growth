/** Types partagés des actions Paramétrage (type-only : importés par des composants client). */

export type SettingsActionErrorCode =
  | "invalid_input"
  | "forbidden"
  | "rate_limited"
  | "duplicate_request"
  | "idempotency_in_progress"
  | "idempotency_conflict"
  | "service_unavailable"
  | "generic";

/** État renvoyé aux formulaires : des codes uniquement, jamais de texte (traduit par l'interface). */
export type SettingsActionState = {
  status: "idle" | "error" | "success";
  code?: SettingsActionErrorCode;
  fieldErrors?: Record<string, string[]>;
};
