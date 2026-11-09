import { disconnectIntegrationSchema } from "@fusion-leap/domain";
import { disconnectIntegration } from "../../../../lib/integrations/service";
import { ServiceError } from "../../../../lib/service/errors";
import { withRoute } from "../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/**
 * Déconnecter une intégration (J28) : `POST /api/integrations/disconnect` `{ integration_id }` supprime son secret, passe son statut
 * à `disconnected` et met ses canaux en pause. Rejouable (déjà déconnectée : 200). `Idempotency-Key` obligatoire. Owner et admin.
 */
export const POST = withRoute(
  {
    name: "integrations.disconnect",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    permission: { action: "disconnect", resource: "integrations" },
    schema: disconnectIntegrationSchema,
  },
  async (ctx, input) => {
    const result = await disconnectIntegration(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) throw new ServiceError(result.code);
    return { status: 200, body: { disconnected: true } };
  },
);
