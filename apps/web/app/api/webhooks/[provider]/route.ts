import { clientIp, ipBucketKey } from "../../../../lib/service/capture-lead";
import { readIntegrationSecret } from "../../../../lib/service/integration-secrets";
import { logger } from "../../../../lib/service/logger";
import { takePublicToken } from "../../../../lib/service/rate-limit";
import { runWithRequestContext } from "../../../../lib/service/request-context";
import { resolveRequestIds } from "../../../../lib/service/request-id";
import { createWebhookStore } from "../../../../lib/service/webhook-store";
import { readBoundedBytes } from "../../../../lib/service/with-service";
import { handleWebhookRequest } from "../../../../lib/webhooks/handle";
import { getWebhookAdapter } from "../../../../lib/webhooks/registry";

export const dynamic = "force-dynamic";

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
      readBody: readBoundedBytes,
      store: createWebhookStore(),
      readSecret: readIntegrationSecret,
      log: (event, fields) => logger.info(event, fields),
    }),
  );
}
