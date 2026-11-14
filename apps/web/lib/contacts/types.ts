/**
 * Types partagés des actions Contacts (type-only : un fichier "use server" ne peut exporter que des fonctions async, et ces
 * types sont aussi importés par des composants client).
 */

export type ContactsActionErrorCode =
  | "invalid_input"
  | "forbidden"
  | "conflict"
  | "not_found"
  | "rate_limited"
  | "duplicate_request"
  | "idempotency_in_progress"
  | "idempotency_conflict"
  | "service_unavailable"
  | "generic";

/** État renvoyé aux formulaires (useActionState) : seulement un code ; l'interface le traduit (fr / ar / en). */
export type ContactsActionState = {
  status: "idle" | "error" | "success";
  code?: ContactsActionErrorCode;
  fieldErrors?: Record<string, string[]>;
  /** Clé de la phrase de succès (`Contacts.success.*`). */
  success?: "consentRecorded" | "consentRevoked" | "doNotContactSet" | "doNotContactCleared";
};
