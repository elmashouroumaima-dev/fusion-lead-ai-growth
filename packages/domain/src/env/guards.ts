import type { EnvSource } from "./parse";

/**
 * Garde-fous anti-fuite (spec §6, invariant 7) — fonctions pures, utilisées par le script CI
 * `scripts/check-client-leaks.ts` et testées unitairement.
 */

/** Noms qui ne doivent jamais apparaître derrière le préfixe public `NEXT_PUBLIC_`. */
const SENSITIVE_NAME =
  /(service[_-]?role|secret|private|password|passwd|token|api[_-]?key|master[_-]?key|jwt[_-]?secret)/i;

/** Exception explicite : la clé « publishable » de Supabase est publique par conception. */
const PUBLIC_NAME_ALLOWLIST = new Set(["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]);

export interface LeakFinding {
  readonly kind:
    "public-variable-name" | "public-variable-value" | "bundle-value" | "bundle-pattern";
  readonly where: string;
  readonly reason: string;
}

/** Rôle porté par un JWT (sans vérifier la signature) ; `undefined` si ce n'est pas un JWT. */
function jwtRole(value: string): string | undefined {
  const parts = value.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as {
      role?: unknown;
    };
    return typeof payload.role === "string" ? payload.role : undefined;
  } catch {
    return undefined;
  }
}

/** Vrai si la valeur ressemble à une clé secrète Supabase (`sb_secret_…` ou JWT `service_role`). */
export function looksLikeSupabaseSecret(value: string): boolean {
  return value.startsWith("sb_secret_") || jwtRole(value) === "service_role";
}

/** Contrôle les variables publiques (`NEXT_PUBLIC_*`) : nom et valeur. */
export function findPublicVariableLeaks(env: EnvSource): LeakFinding[] {
  const findings: LeakFinding[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("NEXT_PUBLIC_")) continue;
    if (!PUBLIC_NAME_ALLOWLIST.has(name) && SENSITIVE_NAME.test(name)) {
      findings.push({
        kind: "public-variable-name",
        where: name,
        reason: "le nom d'une variable publique ne doit pas désigner un secret",
      });
    }
    if (value && looksLikeSupabaseSecret(value)) {
      findings.push({
        kind: "public-variable-value",
        where: name,
        reason: "la valeur ressemble à une clé secrète Supabase (service_role / sb_secret_)",
      });
    }
  }
  return findings;
}

const SECRET_KEY_PATTERN = /sb_secret_[A-Za-z0-9_-]{8,}/;
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;

/**
 * Contrôle le contenu d'un fichier du bundle client : valeurs exactes des secrets serveur connus,
 * clés `sb_secret_…`, JWT dont le rôle est `service_role`. Ne renvoie jamais la valeur trouvée.
 */
export function findBundleLeaks(
  fileLabel: string,
  content: string,
  knownSecretValues: readonly string[] = [],
): LeakFinding[] {
  const findings: LeakFinding[] = [];
  for (const secret of knownSecretValues) {
    if (secret.length >= 8 && content.includes(secret)) {
      findings.push({
        kind: "bundle-value",
        where: fileLabel,
        reason: "une valeur de secret serveur est présente dans le bundle client",
      });
    }
  }
  if (SECRET_KEY_PATTERN.test(content)) {
    findings.push({
      kind: "bundle-pattern",
      where: fileLabel,
      reason: "motif de clé secrète Supabase (sb_secret_…) présent dans le bundle client",
    });
  }
  for (const match of content.matchAll(JWT_PATTERN)) {
    if (jwtRole(match[0]) === "service_role") {
      findings.push({
        kind: "bundle-pattern",
        where: fileLabel,
        reason: "JWT de rôle service_role présent dans le bundle client",
      });
      break;
    }
  }
  return findings;
}
