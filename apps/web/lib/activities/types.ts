/**
 * Types partagés des actions Activités (type-only : un fichier "use server" ne peut exporter que des fonctions async, et ces
 * types sont aussi importés par des composants client).
 */

export type ActivitiesActionErrorCode =
  | "invalid_input"
  | "forbidden"
  | "quota_exceeded"
  | "conflict"
  | "not_found"
  | "rate_limited"
  | "duplicate_request"
  | "idempotency_in_progress"
  | "idempotency_conflict"
  | "service_unavailable"
  | "generic";

/** État renvoyé aux formulaires (useActionState) : seulement un code ; l'interface le traduit (fr / ar / en). */
export type ActivitiesActionState = {
  status: "idle" | "error" | "success";
  code?: ActivitiesActionErrorCode;
  fieldErrors?: Record<string, string[]>;
  /** Clé de la phrase de succès (`Lead.success.*`). */
  success?: "noteAdded" | "callAdded" | "taskAdded" | "taskDone" | "taskReopened";
};
