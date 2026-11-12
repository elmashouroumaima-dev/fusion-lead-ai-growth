import { replaceWebhookSecretSchema } from "@fusion-leap/domain";
import { equalsOtherSecret } from "../../../../lib/integrations/secret-guard";
import { replaceWebhookSecret } from "../../../../lib/integrations/service";
import { readIntegrationSecret } from "../../../../lib/service/integration-secrets";
import { ServiceError } from "../../../../lib/service/errors";
import { withRoute } from "../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/**
 * Enregistrer ou remplacer le secret de WEBHOOK d'une intégration (J32) : `POST /api/integrations/webhook-secret` `{ integration_id, secret }`.
 * C'est le mot de passe du Basic Auth que le fournisseur envoie à chaque événement (l'utilisateur est l'identifiant du compte de l'intégration) ;
 * il est distinct du jeton d'envoi. Écriture seule : la réponse ne renvoie jamais le secret (`{ replaced: true }`). `Idempotency-Key`
 * obligatoire (le secret est exclu de l'empreinte). Owner et admin.
 */
export const POST = withRoute(
  {
    name: "integrations.webhook_secret.replace",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    hashOmit: ["secret"],
    permission: { action: "replace_secret", resource: "integrations" },
    schema: replaceWebhookSecretSchema,
  },
  async (ctx, input) => {
    // le secret de webhook n'est jamais le jeton d'envoi : un secret de webhook divulgué ne doit pas permettre d'envoyer
    let same: boolean;
    try {
      same = await equalsOtherSecret(readIntegrationSecret, ctx.organizationId, input.integration_id, input.secret);
    } catch {
      throw new ServiceError("service_unavailable");
    }
    if (same) throw new ServiceError("validation_failed");
    const result = await replaceWebhookSecret(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) throw new ServiceError(result.code);
    return { status: 200, body: { replaced: true } };
  },
);
