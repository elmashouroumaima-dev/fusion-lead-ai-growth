import { createProviderIntegrationSchema } from "@fusion-leap/domain";
import { createProviderIntegration, listIntegrationViews } from "../../../lib/integrations/service";
import { ServiceError } from "../../../lib/service/errors";
import { withRoute } from "../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/**
 * Intégrations à secret (J28, ADR 004). `GET /api/integrations` : intégrations de l'entreprise (statut, portée, dernière synchro,
 * `has_secret`) avec leurs canaux, JAMAIS un secret. `POST /api/integrations`
 * `{ provider: "email" | "whatsapp", external_account_id, scopes?, secret }` crée l'intégration en statut `pending` : le jeton est
 * chiffré par le serveur et seul le chiffré est enregistré ; la réponse ne le contient pas (`Idempotency-Key` obligatoire, le jeton
 * est exclu de l'empreinte d'idempotence). Owner et admin ; sans clé maître configurée : 503.
 */
const noInput = { safeParse: () => ({ success: true as const, data: {} }) };

export const GET = withRoute(
  { name: "integrations.list", auth: "tenant", rateLimit: "mutation", idempotency: "none", permission: { action: "view_status", resource: "integrations" }, schema: noInput },
  async (ctx) => ({ status: 200, body: { integrations: await listIntegrationViews(ctx.supabase, ctx.organizationId) } }),
);

export const POST = withRoute(
  {
    name: "integrations.create",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    hashOmit: ["secret"],
    permission: { action: "connect", resource: "integrations" },
    schema: createProviderIntegrationSchema,
  },
  async (ctx, input) => {
    const result = await createProviderIntegration(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) throw new ServiceError(result.code);
    return { status: 201, body: { integration: result.value } };
  },
);
