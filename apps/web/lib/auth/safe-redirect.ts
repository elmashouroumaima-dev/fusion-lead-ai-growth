/**
 * Anti open-redirect : `next` n'est accepté que s'il désigne un chemin interne.
 * Règles : une seule `/` initiale (pas `//`), pas de `\`, pas de schéma, pas de caractère de
 * contrôle. La vérification est refaite APRÈS décodage (les navigateurs décodent `%2f`, `%5c`).
 */
// no-control-regex : désactivée pour ce fichier dans eslint.config.mjs (noInlineConfig dans apps/web).
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isInternalPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (path.includes("\\") || CONTROL_CHARS.test(path)) return false;
  return true;
}

export function safeNext(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return fallback;
  if (!isInternalPath(value)) return fallback;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return fallback;
  }
  if (!isInternalPath(decoded)) return fallback;
  // Double encodage (%252f) : on décode une seconde fois par prudence.
  try {
    if (!isInternalPath(decodeURIComponent(decoded))) return fallback;
  } catch {
    return fallback;
  }
  // Dernier garde-fou : l'URL résolue doit rester sur l'origine factice.
  try {
    const base = "http://internal.invalid";
    if (new URL(value, base).origin !== base) return fallback;
  } catch {
    return fallback;
  }
  return value;
}
