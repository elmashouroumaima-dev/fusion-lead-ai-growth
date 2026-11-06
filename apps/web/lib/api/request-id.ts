/** Identifiant de corrélation : alphanumérique + `._-`, 8 à 128 caractères (pas d'injection de log/en-tête). */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Reprend `x-request-id` s'il est sûr (utile derrière un proxy/CDN), sinon en génère un.
 * Une valeur fournie par le client n'est jamais recopiée telle quelle sans validation.
 */
export function getRequestId(headers: Pick<Headers, "get">): string {
  const incoming = headers.get(REQUEST_ID_HEADER);
  return incoming !== null && SAFE_REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
}
