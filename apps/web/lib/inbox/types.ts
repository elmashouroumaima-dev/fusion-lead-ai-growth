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

/** Résultat des actions de verrou (J38) : jamais l'identité de l'autre membre, seulement « à moi », « à un autre » ou « à l'IA ». */
export type LockActionState = {
  status: "idle" | "error" | "success";
  code?: InboxActionErrorCode;
  /** `mine` : bail pris ou renouvelé ; `other` : un autre membre rédige ; `ai` : l'IA tient la conversation ; `released` : bail libéré. */
  lock?: "mine" | "other" | "ai" | "released" | "taken_over";
  /** Fin du bail (ISO), seulement quand `lock` vaut `mine`. */
  expiresAt?: string;
};
