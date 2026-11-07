/**
 * Types partagés du contexte tenant (type-only : un fichier "use server" ne peut exporter que
 * des fonctions async, et ces types sont aussi importés par des composants client).
 */

export type TenantActionErrorCode =
  | "invalid_input"
  | "forbidden"
  | "idempotency_conflict"
  | "rate_limited"
  | "generic";

/**
 * État renvoyé aux formulaires (useActionState). Les actions ne produisent JAMAIS de message
 * lisible : seulement un code ; l'interface le traduit (ar/en).
 */
export type TenantActionState = {
  status: "idle" | "error" | "success";
  code?: TenantActionErrorCode;
  fieldErrors?: Record<string, string[]>;
};
