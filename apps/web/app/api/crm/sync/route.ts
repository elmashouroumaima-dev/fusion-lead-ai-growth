import { requestCrmSyncSchema } from "@fusion-leap/domain";
import { requestSync } from "../../../../lib/crm-sync/service";
import { ServiceError } from "../../../../lib/service/errors";
import { withRoute } from "../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/**
 * Demande de synchro (J25) : `POST /api/crm/sync` `{ integration_id, batch_id }` : le fichier CSV est celui d'un lot déjà ENVOYÉ par
 * le téléversement `POST /api/imports` (jamais confirmé comme un import). La synchro est faite par le worker (job `crm_sync`),
 * jamais dans la requête HTTP : réponse 202. Une seule synchro à la fois par intégration (409). `Idempotency-Key` obligatoire.
 * Owner et admin.
 */
export const POST = withRoute(
  {
    name: "crm.sync.request",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    permission: { action: "connect", resource: "integrations" },
    schema: requestCrmSyncSchema,
  },
  async (ctx, input) => {
    const result = await requestSync(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) throw new ServiceError(result.code);
    return { status: 202, body: { status: "queued", job_id: result.value.jobId } };
  },
);
