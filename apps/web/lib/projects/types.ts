/**
 * Types partagés des actions Projets (type-only : un fichier "use server" ne peut exporter que des fonctions async, et ces
 * types sont aussi importés par des composants client).
 */

export type ProjectsActionErrorCode =
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
  | "file_empty"
  | "file_too_large"
  | "file_type"
  | "file_missing"
  | "too_many_files"
  | "generic";

/** État renvoyé aux formulaires (useActionState) : seulement un code ; l'interface le traduit (fr / ar / en). */
export type ProjectsActionState = {
  status: "idle" | "error" | "success";
  code?: ProjectsActionErrorCode;
  fieldErrors?: Record<string, string[]>;
  /** Clé de la phrase de succès (`Projects.success.*`). */
  success?: "created" | "updated" | "archived" | "reactivated" | "productCreated" | "productUpdated" | "fileUploaded" | "fileRemoved";
};
