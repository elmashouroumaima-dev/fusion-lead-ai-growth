"use server";

import {
  resetRequestSchema,
  signInSchema,
  signOutSchema,
  signUpSchema,
  updatePasswordSchema,
  type AuthLocale,
} from "@fusion-leap/domain";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "../supabase/server";
import { mapAuthError } from "./map-error";
import { RECOVERY_COOKIE } from "./routes";
import { safeNext } from "./safe-redirect";
import { getSiteUrl } from "./site-url";
import type { AuthActionState, AuthErrorCode } from "./types";

const fail = (code: AuthErrorCode, fieldErrors?: Record<string, string[]>): AuthActionState =>
  fieldErrors ? { status: "error", code, fieldErrors } : { status: "error", code };

/** Lit uniquement les champs attendus (pas de `Object.fromEntries` : évite les clés inattendues). */
function field(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

/** Erreurs de champ : noms de champs et codes zod uniquement, jamais les valeurs saisies. */
function toFieldErrors(error: { issues: ReadonlyArray<{ code: string; path: PropertyKey[] }> }): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    (out[key] ??= []).push(issue.code);
  }
  return out;
}

/** `amr` absent : on s'en remet au cookie ; présent : il doit contenir une méthode otp/recovery. */
function isRecoverySession(claims: { amr?: unknown }): boolean {
  if (!Array.isArray(claims.amr) || claims.amr.length === 0) return true;
  return claims.amr.some((entry: unknown) => {
    const method = typeof entry === "string" ? entry : (entry as { method?: unknown } | null)?.method;
    return method === "otp" || method === "recovery";
  });
}

/** Locale valide pour une redirection : la valeur a déjà été validée par zod. */
const home = (locale: AuthLocale): string => `/${locale}/dashboard`;

export async function signUpAction(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = signUpSchema.safeParse({
    email: field(formData, "email"),
    password: field(formData, "password"),
    locale: field(formData, "locale"),
    next: field(formData, "next"),
  });
  if (!parsed.success) return fail("invalid_input", toFieldErrors(parsed.error));
  const { email, password } = parsed.data;

  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({
    email,
    password,
    // URL serveur uniquement ; doit figurer dans additional_redirect_urls (config.toml).
    options: { emailRedirectTo: `${getSiteUrl()}/auth/confirm` },
  });
  // E-mail déjà inscrit : Supabase ne renvoie pas d'erreur (anti-énumération) → même succès.
  if (error) return fail(mapAuthError(error));
  return { status: "success" };
}

export async function signInAction(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = signInSchema.safeParse({
    email: field(formData, "email"),
    password: field(formData, "password"),
    locale: field(formData, "locale"),
    next: field(formData, "next"),
  });
  // Entrée invalide : code invalid_input (erreurs de champs = noms et codes zod, jamais les valeurs).
  if (!parsed.success) return fail("invalid_input", toFieldErrors(parsed.error));
  const { email, password, locale, next } = parsed.data;

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return fail(mapAuthError(error));

  // redirect() lève NEXT_REDIRECT : surtout pas dans un try/catch.
  redirect(safeNext(next, home(locale)));
}

export async function signOutAction(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = signOutSchema.safeParse({ locale: field(formData, "locale") });
  if (!parsed.success) return fail("invalid_input", toFieldErrors(parsed.error));

  const supabase = await createClient();
  // scope local : ne déconnecte que cet appareil.
  await supabase.auth.signOut({ scope: "local" });
  (await cookies()).delete(RECOVERY_COOKIE);
  redirect(`/${parsed.data.locale}/login`);
}

export async function requestPasswordResetAction(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = resetRequestSchema.safeParse({
    email: field(formData, "email"),
    locale: field(formData, "locale"),
  });
  if (!parsed.success) return fail("invalid_input", toFieldErrors(parsed.error));

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${getSiteUrl()}/auth/confirm`,
  });
  // Seule la limite de débit est visible ; toute autre issue = succès générique (anti-énumération).
  if (error && mapAuthError(error) === "rate_limited") return fail("rate_limited");
  return { status: "success" };
}

export async function updatePasswordAction(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = updatePasswordSchema.safeParse({
    password: field(formData, "password"),
    locale: field(formData, "locale"),
  });
  if (!parsed.success) return fail("invalid_input", toFieldErrors(parsed.error));

  // Défense en profondeur (le proxy filtre déjà) : le cookie httpOnly posé par /auth/confirm
  // (type recovery) est requis ; sans lui, une session ordinaire ne peut pas changer le mot de passe.
  const cookieStore = await cookies();
  if (cookieStore.get(RECOVERY_COOKIE)?.value !== "1") return fail("generic");

  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  if (claimsError || !claimsData?.claims) return fail("generic");
  // `amr` (méthodes d'authentification, claim JWT standard de Supabase) : s'il est présent, la
  // session doit provenir d'un lien e-mail (otp/recovery), pas d'une simple connexion par mot de passe.
  if (!isRecoverySession(claimsData.claims)) return fail("generic");

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) return fail(mapAuthError(error));

  // Le mot de passe a changé : on invalide les autres sessions et on consomme le cookie de récupération.
  await supabase.auth.signOut({ scope: "others" });
  cookieStore.delete(RECOVERY_COOKIE);
  return { status: "success" };
}
