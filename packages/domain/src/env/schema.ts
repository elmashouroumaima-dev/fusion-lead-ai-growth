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

export const serverEnvSchema = z.object({
  APP_ENV: z.enum(APP_ENVS),
  SUPABASE_URL: z.url(),
  /**
   * Clé secrète Supabase (équivalent `service_role`, contourne la RLS) :
   * serveur et worker uniquement, jamais dans le navigateur (invariant 7).
   */
  SUPABASE_SECRET_KEY: z.string().min(20),
  /** Fournisseur e-mail (ADR 008, encore « Proposed ») : requis seulement à partir de J31. */
  RESEND_API_KEY: z.string().startsWith("re_").optional(),
  /** ADR 012 : données réelles interdites aux modèles externes tant que non activé. */
  AI_ALLOW_REAL_DATA: z.stringbool().default(false),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;
