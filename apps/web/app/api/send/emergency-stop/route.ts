import { emergencyStopSchema } from "@fusion-leap/domain";
import { setEmergencyStop } from "../../../../lib/operations/service";
import { ServiceError } from "../../../../lib/service/errors";
import { withRoute } from "../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/**
 * Arrêt d'urgence d'envoi (J39) : `POST /api/send/emergency-stop` `{ paused }` bloque (ou rouvre) TOUT envoi de l'entreprise ; le worker
 * le relit à chaque envoi (`organization_paused`). Owner, admin, marketing manager (ADR 014 ligne 9). Rejouable, `Idempotency-Key` obligatoire.
 */
export const POST = withRoute(
  {
    name: "send.emergency_stop",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    permission: { action: "emergency_stop", resource: "sending" },
    schema: emergencyStopSchema,
  },
  async (ctx, input) => {
    const result = await setEmergencyStop(ctx.supabase, ctx.organizationId, input.paused);
    if (!result.ok) throw new ServiceError(result.code);
    return { status: 200, body: { paused: input.paused } };
  },
);
