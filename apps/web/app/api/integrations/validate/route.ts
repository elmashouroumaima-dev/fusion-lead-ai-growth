import { validateIntegrationSchema } from "@fusion-leap/domain";
import { validateIntegrationConnection } from "../../../../lib/service/integration-validation";
import { withRoute } from "../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/**
 * Vérifier la connexion d'une intégration (J34) : `POST /api/integrations/validate` `{ integration_id }`. Le serveur essaie le jeton auprès du
 * fournisseur (WhatsApp : API Graph) et enregistre le résultat : `{ status: "active" }` ou `{ status: "error", code }` (code court, jamais un
 * texte du fournisseur). Panne du fournisseur : 503 sans rien écrire. Owner et admin ; `Idempotency-Key` obligatoire ; limite « sensible »
 * (l'appel sort vers un tiers).
 */
export const POST = withRoute(
  {
    name: "integrations.validate",
    auth: "tenant",
    rateLimit: "sensitive",
    idempotency: { mode: "required", storeResponse: true },
    permission: { action: "connect", resource: "integrations" },
    schema: validateIntegrationSchema,
  },
  async (ctx, input) => {
    const result = await validateIntegrationConnection(ctx.supabase, ctx.organizationId, input.integration_id, ctx.userId);
    return { status: 200, body: result };
  },
);
