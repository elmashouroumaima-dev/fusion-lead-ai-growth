import { replaceIntegrationSecretSchema } from "@fusion-leap/domain";
import { replaceIntegrationSecret } from "../../../../lib/integrations/service";
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
    const result = await replaceIntegrationSecret(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) throw new ServiceError(result.code);
    return { status: 200, body: { replaced: true } };
  },
);
