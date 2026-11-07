/** Identifiant de corrélation fourni par un client : alphanumérique + `._-`, 8 à 128 caractères (pas d'injection de log/en-tête). */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

export const REQUEST_ID_HEADER = "x-request-id";

export type RequestIds = {
  /** Toujours généré côté serveur (uuid) : c'est lui qui est renvoyé en en-tête, dans le corps et dans les journaux. */
  requestId: string;
  /** `x-request-id` du client, seulement s'il est sûr : journalisé pour la corrélation, JAMAIS renvoyé comme `request_id`. */
  clientRequestId?: string;
};

/**
 * Un client ne choisit jamais le `request_id` du serveur (sinon il pourrait forger ou rejouer des identifiants
 * d'audit). Son éventuel `x-request-id` valide est conservé à part (`client_request_id`).
 */
export function resolveRequestIds(headers: Pick<Headers, "get">): RequestIds {
  const incoming = headers.get(REQUEST_ID_HEADER);
  const requestId = crypto.randomUUID();
  return incoming !== null && SAFE_REQUEST_ID.test(incoming) ? { requestId, clientRequestId: incoming } : { requestId };
}
