/**
 * Erreurs de job. Seul un CODE court est transmis à la base (`last_error`) : jamais le message d'une exception
 * (il peut contenir une donnée de contact, un jeton ou un corps de message).
 */

/** Erreur définitive : inutile de réessayer (charge utile invalide, type inconnu, règle métier refusée). */
export class NonRetryableError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "NonRetryableError";
    this.code = safeCode(code);
  }
}

const SAFE = /[^A-Za-z0-9_.:-]/g;

/** Réduit un texte à un code sûr (alphabet restreint, 64 caractères au plus). */
export function safeCode(raw: string): string {
  const cleaned = raw.replace(SAFE, "_").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "error";
}

/** Code d'erreur à enregistrer : `code` d'une NonRetryableError, sinon le NOM de l'erreur, jamais son message. */
export function errorCode(error: unknown): string {
  if (error instanceof NonRetryableError) return error.code;
  if (error instanceof Error && error.name) return safeCode(error.name);
  return "error";
}
