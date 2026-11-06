/** Codes d'erreur autorisés dans `?error=` (liste blanche : jamais de texte libre depuis l'URL). */
export const INITIAL_ERROR_CODES = ["link_invalid"] as const;
export type InitialErrorCode = (typeof INITIAL_ERROR_CODES)[number];

export function parseInitialError(value: unknown): InitialErrorCode | undefined {
  return typeof value === "string" ? INITIAL_ERROR_CODES.find((c) => c === value) : undefined;
}
