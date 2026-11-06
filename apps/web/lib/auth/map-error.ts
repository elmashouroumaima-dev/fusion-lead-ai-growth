import type { AuthErrorCode } from "./types";

/**
 * Traduit une erreur Supabase Auth en code générique. Aucun code ne distingue « compte inconnu »
 * de « mauvais mot de passe » (anti-énumération) ; le message de l'erreur n'est jamais relayé.
 */
export function mapAuthError(error: {
  code?: string | undefined;
  status?: number | undefined;
}): AuthErrorCode {
  switch (error.code) {
    case "invalid_credentials":
    case "invalid_login_credentials":
      return "invalid_credentials";
    case "email_not_confirmed":
      return "email_not_confirmed";
    case "weak_password":
      return "weak_password";
    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
    case "over_sms_send_rate_limit":
      return "rate_limited";
    default:
      return error.status === 429 ? "rate_limited" : "generic";
  }
}
