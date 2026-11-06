import type { ZodType } from "zod";
import { clientEnvSchema, serverEnvSchema, type ClientEnv, type ServerEnv } from "./schema";

export type EnvSource = Record<string, string | undefined>;

/**
 * Erreur de validation d'environnement. Le message liste les NOMS des variables fautives et la
 * nature du problème, jamais leurs valeurs (invariant 12 : pas de secret dans les logs).
 */
export class EnvValidationError extends Error {
  readonly variables: readonly string[];

  constructor(
    scope: "client" | "server",
    variables: readonly string[],
    details: readonly string[],
  ) {
    super(
      `Environnement ${scope} invalide — ${variables.length} variable(s) en erreur :\n` +
        details.map((line) => `  - ${line}`).join("\n"),
    );
    this.name = "EnvValidationError";
    this.variables = variables;
  }
}

function parseWith<T>(scope: "client" | "server", schema: ZodType<T>, source: EnvSource): T {
  const result = schema.safeParse(source);
  if (result.success) return result.data;

  const names = new Set<string>();
  const details: string[] = [];
  for (const issue of result.error.issues) {
    const name = issue.path.length > 0 ? issue.path.join(".") : "(environnement)";
    names.add(name);
    const missing = source[name] === undefined || source[name] === "";
    details.push(`${name} : ${missing ? "manquante" : "invalide"} (${issue.code})`);
  }
  throw new EnvValidationError(scope, [...names], details);
}

export function parseClientEnv(source: EnvSource): ClientEnv {
  return parseWith("client", clientEnvSchema, source);
}

export function parseServerEnv(source: EnvSource): ServerEnv {
  return parseWith("server", serverEnvSchema, source);
}
