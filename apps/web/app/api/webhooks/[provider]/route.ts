import { answerWhatsAppChallenge } from "@fusion-leap/adapters";
import { getServerEnv } from "../../../../lib/env/server";
import { clientIp, ipBucketKey } from "../../../../lib/service/capture-lead";
import { readIntegrationWebhookSecret } from "../../../../lib/service/integration-secrets";
import { logger } from "../../../../lib/service/logger";
import { takePublicToken } from "../../../../lib/service/rate-limit";
import { runWithRequestContext } from "../../../../lib/service/request-context";
import { resolveRequestIds } from "../../../../lib/service/request-id";
import { createWebhookStore } from "../../../../lib/service/webhook-store";
import { readBoundedBytes } from "../../../../lib/service/with-service";
import { handleWebhookRequest } from "../../../../lib/webhooks/handle";
import { getWebhookAdapter } from "../../../../lib/webhooks/registry";

export const dynamic = "force-dynamic";

/** Site en HTTPS (production, staging) : le webhook refuse tout transport non sécurisé ; en développement local (http), pas d'exigence. */
const requiresHttps = (): boolean => {
  try {
    return (getServerEnv().SITE_URL ?? "").startsWith("https://");
  } catch {
    return true;
  }
};
/** Protocole vu par l'application : l'en-tête du proxy de confiance quand il existe, sinon celui de l'adresse demandée. */
const isSecureRequest = (request: Request): boolean => {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  return (forwarded && forwarded.length > 0 ? forwarded : new URL(request.url).protocol.replace(":", "")) === "https";
};

/**
 * POST /api/webhooks/[provider] (J29, spec §8) : réception générique des webhooks, sans session. Voir `lib/webhooks/handle.ts` pour
 * l'ordre des contrôles et les réponses. Un fournisseur sans adaptateur enregistré (`lib/webhooks/registry.ts`) répond 404. L'ACK est
 * rapide : l'événement est enregistré puis traité plus tard par le job `process_webhook` du worker.
 */
export async function POST(request: Request, context: { params: Promise<{ provider: string }> }): Promise<Response> {
  const { requestId } = resolveRequestIds(request.headers);
  const { provider } = await context.params;
  return runWithRequestContext({ requestId }, () =>
    handleWebhookRequest(request, provider, requestId, {
      getAdapter: getWebhookAdapter,
      // seau par fournisseur ET par adresse (IPv6 agrégée par /64 dans `ipBucketKey`) : une plage IPv6 entière ne multiplie pas les seaux
      limit: ({ provider: name, ip }) => takePublicToken({ scope: "webhook_ip", bucketKey: `${name}:${ipBucketKey(ip)}` }),
      clientIp: (headers) => clientIp(headers),
      requireHttps: requiresHttps(),
      isSecure: isSecureRequest,
      readBody: readBoundedBytes,
      store: createWebhookStore(),
      // le secret de WEBHOOK (Basic Auth du fournisseur), distinct du jeton d'envoi : un secret de webhook divulgué ne permet pas d'envoyer
      readSecret: readIntegrationWebhookSecret,
      log: (event, fields) => logger.info(event, fields),
    }),
  );
}

/**
 * GET /api/webhooks/whatsapp (J34) : poignée de main d'abonnement de Meta (`hub.mode`, `hub.verify_token`, `hub.challenge`). Le jeton est celui de la
 * PLATEFORME (`WHATSAPP_VERIFY_TOKEN`) : la requête ne porte aucun compte. Répond le défi en texte brut, sinon 403 ; 404 pour tout autre fournisseur
 * ou quand le jeton n'est pas configuré. Limitée par adresse comme les webhooks ; n'écrit rien.
 */
export async function GET(request: Request, context: { params: Promise<{ provider: string }> }): Promise<Response> {
  const { requestId } = resolveRequestIds(request.headers);
  const { provider } = await context.params;
  const headers = { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" };
  if (provider !== "whatsapp") return new Response(null, { status: 404, headers });
  let expected: string | undefined;
  try {
    expected = getServerEnv().WHATSAPP_VERIFY_TOKEN;
  } catch {
    expected = undefined;
  }
  if (!expected) return new Response(null, { status: 404, headers });
  return runWithRequestContext({ requestId }, async () => {
    try {
      const limit = await takePublicToken({ scope: "webhook_ip", bucketKey: `${provider}:${ipBucketKey(clientIp(request.headers) ?? "unknown")}` });
      if (!limit.allowed) return new Response(null, { status: 429, headers: { ...headers, "retry-after": String(limit.retryAfterSeconds) } });
    } catch {
      return new Response(null, { status: 503, headers });
    }
    const challenge = answerWhatsAppChallenge(new URL(request.url).searchParams, expected);
    return challenge === null ? new Response(null, { status: 403, headers }) : new Response(challenge, { status: 200, headers });
  });
}
