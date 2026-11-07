import { localeSchema, type AuthLocale } from "@fusion-leap/domain";
import { DEFAULT_LOCALE } from "../auth/routes";
import type { ServiceErrorCode } from "./errors";

/** Lit uniquement les champs attendus ; une valeur absente ou non textuelle donne `undefined`. */
export function field(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

/** Erreurs de champ : noms de champs et codes zod uniquement, jamais les valeurs saisies. */
export function toFieldErrors(error: { issues: ReadonlyArray<{ code: string; path: PropertyKey[] }> }): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    (out[key] ??= []).push(issue.code);
  }
  return out;
}

/** Locale de l'interface (redirections, lien d'invitation) : valeur validée, repli sur la locale par défaut. */
export function uiLocaleOf(formData: FormData): AuthLocale {
  const parsed = localeSchema.safeParse(field(formData, "uiLocale"));
  return parsed.success ? parsed.data : DEFAULT_LOCALE;
}

/** Codes d'état de formulaire communs à toutes les actions passant par la couche service. */
export type ServiceFormErrorCode =
  | "invalid_input"
  | "forbidden"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "duplicate_request"
  | "rate_limited"
  | "service_unavailable"
  | "generic";

/**
 * UNIQUE table code de la couche service -> code d'état de formulaire (tenant et membres). Jamais de texte brut.
 * `idempotency_in_progress` reste distinct de `duplicate_request` : dans le premier cas la clé doit être
 * conservée (le résultat n'est pas encore connu), dans le second la demande est terminée.
 */
export function serviceCodeToFormCode(code: ServiceErrorCode): ServiceFormErrorCode {
  switch (code) {
    case "validation_failed":
    case "payload_too_large":
      return "invalid_input";
    case "forbidden":
    case "unauthenticated":
      return "forbidden";
    case "idempotency_conflict":
      return "idempotency_conflict";
    case "idempotency_in_progress":
      return "idempotency_in_progress";
    case "duplicate_request":
      return "duplicate_request";
    case "rate_limited":
    case "quota_exceeded":
      return "rate_limited";
    case "service_unavailable":
      return "service_unavailable";
    default:
      return "generic";
  }
}
