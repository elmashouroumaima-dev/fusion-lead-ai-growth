import { retryCrmSyncSchema } from "@fusion-leap/domain";
import { retrySync } from "../../../../../lib/crm-sync/service";
import { ServiceError } from "../../../../../lib/service/errors";
import { withRoute } from "../../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/**
 * « Réessayer » (J25) : `POST /api/crm/sync/retry` `{ integration_id }` rejoue la dernière synchro en ÉCHEC DÉFINITIF (même fichier, même
 * job : sans doublon, l'identifiant externe rend la synchro idempotente). `{ retried: false }` si rien n'était à rejouer. Réponse 202 si
 * rejouée. `Idempotency-Key` obligatoire. Owner et admin.
 */
export const POST = withRoute(
  {
    name: "crm.sync.retry",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    permission: { action: "connect", resource: "integrations" },
    schema: retryCrmSyncSchema,
  },
  async (ctx, input) => {
    const result = await retrySync(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) throw new ServiceError(result.code);
    return { status: result.value.retried ? 202 : 200, body: { retried: result.value.retried } };
  },
);
