/**
 * Types partagés des actions Membres (type-only : un fichier "use server" ne peut exporter que des
 * fonctions async, et ces types sont aussi importés par des composants client).
 */

export type MembersActionErrorCode =
  | "invalid_input"
  | "forbidden"
  | "already_member"
  | "invitation_invalid"
  | "last_owner"
  | "quota_exceeded"
  | "rate_limited"
  | "duplicate_request"
  | "idempotency_in_progress"
  | "idempotency_conflict"
  | "service_unavailable"
  | "generic";

/**
 * État renvoyé aux formulaires (useActionState). Les actions ne produisent JAMAIS de message lisible :
 * seulement un code ; l'interface le traduit (fr/ar/en). `invitePath` n'existe que dans la réponse à
 * une invitation réussie : c'est la seule fois où le lien est connu du serveur (seul le hash est stocké).
 */
export type MembersActionState = {
  status: "idle" | "error" | "success";
  code?: MembersActionErrorCode;
  fieldErrors?: Record<string, string[]>;
  invitePath?: string;
};
