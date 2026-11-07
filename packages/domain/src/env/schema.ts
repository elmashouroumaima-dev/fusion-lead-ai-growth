import { z } from "zod";

/**
 * Variables d'environnement — spec §6 (secrets hors navigateur), §11, CLAUDE.md.
 *
 * Deux schémas strictement séparés :
 *  - `clientEnvSchema` : uniquement des variables `NEXT_PUBLIC_*`, visibles dans le navigateur ;
 *  - `serverEnvSchema` : serveur Next.js + worker ; contient les secrets (clé secrète Supabase).
 *
 * Règle : aucune variable `NEXT_PUBLIC_*` ne contient de secret (voir `guards.ts`).
 */

export const APP_ENVS = ["development", "staging", "production", "test"] as const;

export const clientEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  /** Clé « publishable » Supabase (publique par conception, soumise à la RLS). */
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
});

/** Repli de développement local pour SITE_URL (staging/production : variable obligatoire). */
export const DEV_SITE_URL = "http://127.0.0.1:3000";

export const serverEnvSchema = z
  .object({
  APP_ENV: z.enum(APP_ENVS),
  /**
   * URL publique du site (liens des e-mails d'authentification). Serveur uniquement, jamais
   * NEXT_PUBLIC_*. Optionnelle en développement/test (repli DEV_SITE_URL), obligatoire et en
   * https en staging/production. Chaîne vide = absente.
   */
  SITE_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.url({ protocol: /^https?$/ }).optional(),
  ),
  SUPABASE_URL: z.url(),
  /**
   * Clé secrète Supabase (équivalent `service_role`, contourne la RLS) :
   * serveur et worker uniquement, jamais dans le navigateur (invariant 7).
   */
  SUPABASE_SECRET_KEY: z.string().min(20),
  /** Fournisseur e-mail (ADR 008, encore « Proposed ») : requis seulement à partir de J31. */
  RESEND_API_KEY: z.string().startsWith("re_").optional(),
  /**
   * Clé maître (base64, exactement 32 octets) du chiffrement applicatif des secrets (ADR 004, AES-256-GCM).
   * Serveur uniquement, jamais NEXT_PUBLIC_*, jamais dans la base ni dans le dépôt. Optionnelle : sans elle, les
   * fonctions qui stockent un secret (mot de passe SMTP) sont désactivées. Chaîne vide = absente.
   */
  SECRETS_MASTER_KEY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .refine((v) => /^[A-Za-z0-9+/]+={0,2}$/.test(v) && Buffer.from(v, "base64").length === 32, {
        message: "base64 de 32 octets requis",
      })
      // Refuse les clés triviales (32 octets identiques, séquence courte...) : au moins 16 valeurs d'octet distinctes.
      .refine((v) => new Set(Buffer.from(v, "base64")).size >= 16, { message: "clé trop prévisible" })
      .optional(),
  ),
  /** Version de la clé maître courante (rotation, ADR 004). */
  SECRETS_KEY_VERSION: z.coerce.number().int().min(1).max(1000).default(1),
  /** ADR 012 : données réelles interdites aux modèles externes tant que non activé. */
  AI_ALLOW_REAL_DATA: z.stringbool().default(false),
  })
  .superRefine((env, ctx) => {
    if (env.APP_ENV !== "staging" && env.APP_ENV !== "production") return;
    if (env.SITE_URL === undefined) {
      ctx.addIssue({ code: "custom", path: ["SITE_URL"], message: "requise" });
    } else if (new URL(env.SITE_URL).protocol !== "https:") {
      ctx.addIssue({ code: "custom", path: ["SITE_URL"], message: "https requis" });
    }
  })
  .transform((env) => ({ ...env, SITE_URL: env.SITE_URL ?? DEV_SITE_URL }));

export type ClientEnv = z.infer<typeof clientEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;
