import { localeSchema, type AuthLocale } from "@fusion-leap/domain";
import { DEFAULT_LOCALE } from "../auth/routes";
import type { MembersActionErrorCode, MembersActionState } from "./types";

export const fail = (code: MembersActionErrorCode, fieldErrors?: Record<string, string[]>): MembersActionState =>
  fieldErrors ? { status: "error", code, fieldErrors } : { status: "error", code };

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
