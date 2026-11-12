import { saveCrmMappingsSchema } from "@fusion-leap/domain";
import { saveMappings } from "../../../../lib/crm-sync/service";
import { ServiceError } from "../../../../lib/service/errors";
import { withRoute } from "../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/**
 * Mapping de champs d'une intégration (J25) : `POST /api/crm/mappings` `{ integration_id, mappings: [{ entity, internal_field,
 * external_field, source_of_truth, direction }] }` REMPLACE tout le mapping (2 à 20 entrées, `external_id` obligatoire, champs internes
 * en liste blanche, identifiant et date externes en lecture seulement). `Idempotency-Key` obligatoire. Owner et admin.
 */
export const POST = withRoute(
  {
    name: "crm.mappings.save",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    permission: { action: "connect", resource: "integrations" },
    schema: saveCrmMappingsSchema,
  },
  async (ctx, input) => {
    const result = await saveMappings(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) throw new ServiceError(result.code);
    return { status: 200, body: { saved: input.mappings.length } };
  },
);
