import { DEFAULT_LOCALE, LOCALES, type AuthLocale } from "@fusion-leap/domain";

/** Cookie court posé par /auth/confirm (type recovery) : autorise l'écran reset-password. */
export const RECOVERY_COOKIE = "fl_recovery";

/** Repli de locale : réexport de la source unique (domain). */
export { DEFAULT_LOCALE };

/** Pages publiques (sans le préfixe de locale). */
const PUBLIC_PATHS = new Set(["", "/", "/login", "/signup", "/forgot-password", "/reset-password"]);
/** Pages réservées aux visiteurs non connectés (un utilisateur connecté va au tableau de bord). */
const GUEST_ONLY_PATHS = new Set(["/login", "/signup"]);

export type ParsedPath = { locale: AuthLocale; rest: string } | null;

/**
 * Sépare `/{locale}/reste` sur un chemin DÉJÀ décodé (voir `normalizePathname`). Correspondance
 * exacte et sensible à la casse sur le premier segment ; `//ar/x`, `/arx/x`, `/AR/x` -> null.
 */
export function parseLocalePath(pathname: string): ParsedPath {
  const match = /^\/([^/]+)(\/.*)?$/.exec(pathname);
  const locale = LOCALES.find((l) => l === match?.[1]);
  if (!match || !locale) return null;
  const rest = (match[2] ?? "").replace(/\/+$/, "");
  return { locale, rest };
}

// no-control-regex : désactivée pour ce fichier dans eslint.config.mjs (noInlineConfig dans apps/web).
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f\\]/;

/**
 * Forme canonique d'un chemin de requête, ou null s'il doit être refusé (fail closed).
 * Next.js route sur le chemin DÉCODÉ : la décision d'accès doit donc se prendre sur le même
 * chemin, sinon `/%61r/dashboard` contournerait la protection de `/ar/dashboard`.
 * Refusés : encodage malformé, séparateurs encodés (%2f, %5c), double encodage (%25), segments
 * `.`/`..` (même encodés), antislash, caractères de contrôle, `//` (brut ou décodé).
 */
export function normalizePathname(pathname: string): string | null {
  if (!pathname.startsWith("/") || /%(?:2f|5c|25)/i.test(pathname)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (FORBIDDEN_CHARS.test(decoded) || decoded.includes("//")) return null;
  if (decoded.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return decoded;
}

export const isPublicPath = (rest: string): boolean => PUBLIC_PATHS.has(rest);
export const isGuestOnlyPath = (rest: string): boolean => GUEST_ONLY_PATHS.has(rest);
