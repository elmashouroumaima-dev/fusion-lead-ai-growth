import { replaceIntegrationSecretSchema } from "@fusion-leap/domain";
import { equalsOtherSecret } from "../../../../lib/integrations/secret-guard";
import { replaceIntegrationSecret } from "../../../../lib/integrations/service";
import { readIntegrationWebhookSecret } from "../../../../lib/service/integration-secrets";
import { ServiceError } from "../../../../lib/service/errors";
import { withRoute } from "../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/**
 * Remplacer le jeton d'une intégration (J28) : `POST /api/integrations/secret` `{ integration_id, secret }`. C'est une ROTATION : le
 * nouveau secret chiffré est écrit puis l'ancien supprimé dans la même transaction. Écriture seule : la réponse ne renvoie jamais le
 * secret (`{ replaced: true }`). `Idempotency-Key` obligatoire (le jeton est exclu de l'empreinte). Owner et admin.
 */
export const POST = withRoute(
  {
    name: "integrations.secret.replace",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    hashOmit: ["secret"],
    permission: { action: "replace_secret", resource: "integrations" },
    schema: replaceIntegrationSecretSchema,
  },
  async (ctx, input) => {
    // le jeton d'envoi n'est jamais le secret de webhook (J32)
    let same: boolean;
    try {
      same = await equalsOtherSecret(readIntegrationWebhookSecret, ctx.organizationId, input.integration_id, input.secret);
    } catch {
      throw new ServiceError("service_unavailable");
    }
    if (same) throw new ServiceError("validation_failed");
    const result = await replaceIntegrationSecret(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) throw new ServiceError(result.code);
    return { status: 200, body: { replaced: true } };
  },
);
