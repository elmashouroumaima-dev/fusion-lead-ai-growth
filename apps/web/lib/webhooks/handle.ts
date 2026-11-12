import { ingestWebhook, type WebhookAdapter, type WebhookSecretReader, type WebhookStore } from "@fusion-leap/adapters";
import { errorResponse, ServiceError } from "../service/errors";
import { REQUEST_ID_HEADER } from "../service/request-id";

/**
 * Route publique de réception des webhooks (J29, spec §8 et §11). SANS session : le fournisseur est identifié par l'adresse de la
 * route, l'entreprise par le COMPTE fournisseur lu dans le corps, l'authenticité par la SIGNATURE sur le corps brut (pipeline commun
 * `ingestWebhook`). Dépendances injectées : la logique se teste sans Next ni base.
 *
 * Réponses : 200 `{ status: "accepted" | "duplicate" }`, 400 corps illisible ou sans compte ni identifiant, 401 signature invalide, horodatage
 * hors fenêtre OU compte inconnu (UNE seule réponse : aucun oracle d'existence d'un compte), 404 fournisseur sans adaptateur, 413 corps trop gros,
 * 429 trop de requêtes, 503 panne, file saturée ou adresse source inconnue (le fournisseur réessaie).
 * Jamais de payload, d'en-tête d'authentification ni de secret dans les journaux ou les réponses.
 */
export type WebhookRouteDeps = {
  getAdapter(provider: string): WebhookAdapter | null;
  limit(input: { provider: string; ip: string }): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  clientIp(headers: Headers): string | null;
  /** Transport sécurisé exigé (production, staging) : le mot de passe du Basic Auth circule à chaque requête, jamais en HTTP. */
  requireHttps?: boolean;
  isSecure?(request: Request): boolean;
  readBody(request: Request, limit: number): Promise<Uint8Array>;
  store: WebhookStore;
  readSecret: WebhookSecretReader;
  log(event: string, fields: Record<string, unknown>): void;
  now?: () => number;
};

const PROVIDER_PARAM = /^[a-z]{2,20}$/;
const noStore = (requestId: string): Record<string, string> => ({ "cache-control": "no-store", [REQUEST_ID_HEADER]: requestId });

export async function handleWebhookRequest(request: Request, providerParam: string, requestId: string, deps: WebhookRouteDeps): Promise<Response> {
  try {
    const adapter = PROVIDER_PARAM.test(providerParam) ? deps.getAdapter(providerParam) : null;
    if (!adapter) throw new ServiceError("not_found");

    // refus AVANT toute lecture : un secret reçu en clair est déjà exposé, on ne le traite pas
    if (deps.requireHttps && !(deps.isSecure?.(request) ?? false)) {
      deps.log("webhook.insecure_transport", { request_id: requestId, provider: adapter.provider });
      throw new ServiceError("validation_failed");
    }

    const ip = deps.clientIp(request.headers);
    // adresse source introuvable (proxy mal configuré, `TRUSTED_PROXY_HOPS`) : refus visible plutôt qu'un seau commun à tous les appelants
    if (ip === null) {
      deps.log("webhook.no_client_ip", { request_id: requestId, provider: adapter.provider });
      throw new ServiceError("service_unavailable");
    }
    const limit = await deps.limit({ provider: adapter.provider, ip });
    if (!limit.allowed) throw new ServiceError("rate_limited", { retryAfterSeconds: limit.retryAfterSeconds });

    const rawBody = await deps.readBody(request, adapter.maxBytes);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });

    const outcome = await ingestWebhook({
      adapter,
      rawBody,
      headers,
      store: deps.store,
      readSecret: deps.readSecret,
      ...(deps.now ? { now: deps.now } : {}),
    });
    deps.log(`webhook.${outcome.kind}`, { request_id: requestId, provider: adapter.provider });

    switch (outcome.kind) {
      case "accepted":
      case "duplicate":
        return Response.json({ status: outcome.kind }, { status: 200, headers: noStore(requestId) });
      case "too_large":
        throw new ServiceError("payload_too_large");
      case "bad_request":
        throw new ServiceError("validation_failed");
      case "invalid_signature":
        throw new ServiceError("unauthenticated");
    }
  } catch (error) {
    if (error instanceof ServiceError) deps.log("webhook.refused", { request_id: requestId, code: error.code });
    else deps.log("webhook.error", { request_id: requestId });
    return errorResponse(error, requestId);
  }
}
