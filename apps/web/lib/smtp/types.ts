/** Types partagés des actions SMTP (type-only : importés par des composants client). */

export type SmtpActionErrorCode =
  | "invalid_input"
  | "forbidden"
  | "rate_limited"
  | "duplicate_request"
  | "idempotency_in_progress"
  | "idempotency_conflict"
  | "service_unavailable"
  | "generic"
  /** Clé maître de chiffrement absente : le mot de passe ne peut pas être enregistré. */
  | "secrets_unavailable"
  | "not_configured"
  /** L'hôte, le port ou l'utilisateur ont changé : le mot de passe doit être ressaisi. */
  | "password_required"
  | "blocked_host"
  | "auth_failed"
  | "connection_failed"
  | "timeout"
  | "rejected"
  | "failed";

/** État renvoyé aux formulaires : des codes uniquement, jamais de texte (traduit par l'interface). */
export type SmtpActionState = {
  status: "idle" | "error" | "success";
  code?: SmtpActionErrorCode;
  fieldErrors?: Record<string, string[]>;
};
