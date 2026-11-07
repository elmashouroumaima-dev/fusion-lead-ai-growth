/**
 * Types partagés Auth (type-only, sans "use server" : un fichier "use server" ne peut exporter
 * que des fonctions async, et ces types sont aussi importés par les composants client).
 */

export type AuthErrorCode =
  | "invalid_input"
  | "invalid_credentials"
  | "email_not_confirmed"
  | "weak_password"
  | "rate_limited"
  | "generic";

/**
 * État renvoyé aux formulaires (useActionState). Les actions ne produisent JAMAIS de message
 * lisible : seulement un code ; l'interface le traduit (fr/ar/en). Aucun code ne révèle si un
 * compte existe.
 */
export type AuthActionState = {
  status: "idle" | "error" | "success";
  code?: AuthErrorCode;
  fieldErrors?: Record<string, string[]>;
};
