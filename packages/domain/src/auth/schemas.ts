import { z } from "zod";

/**
 * Schémas d'authentification (J8). Source unique pour les Server Actions et le callback e-mail.
 * La longueur minimale du mot de passe est mirrorée dans supabase/config.toml
 * (`minimum_password_length`) : changer l'une impose de changer l'autre.
 */
export const PASSWORD_MIN_LENGTH = 10;
/** bcrypt (GoTrue) tronque/refuse au-delà de 72 octets : on borne côté entrée. */
export const PASSWORD_MAX_LENGTH = 72;

/** Locales de l'interface (ADR 011, amendé) : fr (défaut, ltr), ar (rtl), en (ltr). Source unique. */
export const LOCALES = ["fr", "ar", "en"] as const;
export const localeSchema = z.enum(LOCALES);
export type AuthLocale = z.infer<typeof localeSchema>;
/** Locale par défaut : routage, repli des redirections et défaut des organisations. */
export const DEFAULT_LOCALE: AuthLocale = "fr";

const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());
const newPasswordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

/** `next` est validé séparément par safeNext() : ici simple chaîne bornée, optionnelle. */
const nextSchema = z.string().max(2048).optional();

export const signUpSchema = z.object({
  email: emailSchema,
  password: newPasswordSchema,
  locale: localeSchema,
  next: nextSchema,
});

export const signInSchema = z.object({
  email: emailSchema,
  // Pas de politique de longueur à la connexion : ne révèle rien et ne bloque pas d'anciens comptes.
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  locale: localeSchema,
  next: nextSchema,
});

export const resetRequestSchema = z.object({
  email: emailSchema,
  locale: localeSchema,
});

export const updatePasswordSchema = z.object({
  password: newPasswordSchema,
  locale: localeSchema,
});

export const signOutSchema = z.object({ locale: localeSchema });

/** Types OTP e-mail acceptés par /auth/confirm (sous-ensemble de EmailOtpType de supabase-js). */
export const emailOtpTypeSchema = z.enum([
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
]);
export type EmailOtpType = z.infer<typeof emailOtpTypeSchema>;

export const confirmQuerySchema = z.object({
  token_hash: z.string().min(1).max(512),
  type: emailOtpTypeSchema,
  next: z.string().max(2048).optional(),
});

export type SignUpInput = z.infer<typeof signUpSchema>;
export type SignInInput = z.infer<typeof signInSchema>;
export type ResetRequestInput = z.infer<typeof resetRequestSchema>;
export type UpdatePasswordInput = z.infer<typeof updatePasswordSchema>;

/** URL publique du site (http/https uniquement), utilisée pour construire les liens d'e-mail. */
export const siteUrlSchema = z.url({ protocol: /^https?$/ });
