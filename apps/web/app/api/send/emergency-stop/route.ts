import { emergencyStopSchema } from "@fusion-leap/domain";
import { setEmergencyStop } from "../../../../lib/operations/service";
import { ServiceError } from "../../../../lib/service/errors";
import { withRoute } from "../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/**
 * Arrêt d'urgence d'envoi (J39) : `POST /api/send/emergency-stop` `{ paused }` bloque (ou rouvre) TOUT envoi de l'entreprise ; le worker
 * le relit à chaque envoi (`organization_paused`). Arrêter : owner, admin, marketing manager (ADR 014 ligne 9) ; REPRENDRE : owner et admin seulement (S-05 : la
 * reprise est le sens risqué ; la fonction SQL le revérifie). Rejouable, `Idempotency-Key` obligatoire.
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
    if (!input.paused && ctx.role !== "company_owner" && ctx.role !== "company_admin") throw new ServiceError("forbidden");
    const result = await setEmergencyStop(ctx.supabase, ctx.organizationId, input.paused);
    if (!result.ok) throw new ServiceError(result.code);
    return { status: 200, body: { paused: input.paused } };
  },
);
