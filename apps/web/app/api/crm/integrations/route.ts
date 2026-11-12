import { createCrmIntegrationSchema } from "@fusion-leap/domain";
import { createIntegration, listIntegrations } from "../../../../lib/crm-sync/service";
import { ServiceError } from "../../../../lib/service/errors";
import { withRoute } from "../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/**
 * Intégrations CRM (J25). `GET /api/crm/integrations` : intégrations de l'entreprise avec leur mapping et leur STATUT de synchro
 * (jamais synchronisé / en file / en cours / réussi / en échec, dernière synchro réussie, dernière erreur en code).
 * `POST /api/crm/integrations` `{ provider: "csv" | "internal", external_account_id }` crée une intégration (`Idempotency-Key`
 * obligatoire). Owner et admin ; l'entreprise est celle du contexte vérifié.
 */
const noInput = { safeParse: () => ({ success: true as const, data: {} }) };

export const GET = withRoute(
  { name: "crm.integrations.list", auth: "tenant", rateLimit: "mutation", idempotency: "none", permission: { action: "view_status", resource: "integrations" }, schema: noInput },
  async (ctx) => ({ status: 200, body: { integrations: await listIntegrations(ctx.supabase, ctx.organizationId) } }),
);

export const POST = withRoute(
  {
    name: "crm.integrations.create",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    permission: { action: "connect", resource: "integrations" },
    schema: createCrmIntegrationSchema,
  },
  async (ctx, input) => {
    const result = await createIntegration(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) throw new ServiceError(result.code);
    return { status: 201, body: { integration: result.value } };
  },
);
