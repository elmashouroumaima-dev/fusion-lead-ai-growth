/**
 * Types partagés des actions de la boîte de réception (J37). Type-only : un fichier "use server" ne peut exporter que des fonctions
 * async, et ces types sont aussi importés par des composants client.
 */

export type InboxActionErrorCode =
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
export type InboxActionState = {
  status: "idle" | "error" | "success";
  code?: InboxActionErrorCode;
  fieldErrors?: Record<string, string[]>;
  /** Clé de la phrase de succès (`Inbox.success.*`). */
  success?: "assigned" | "unassigned" | "stateChanged";
};
