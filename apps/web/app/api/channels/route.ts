import { createChannelSchema } from "@fusion-leap/domain";
import { createChannel } from "../../../lib/integrations/service";
import { ServiceError } from "../../../lib/service/errors";
import { withRoute } from "../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/**
 * Ajouter un canal (écran de canaux, ADR 007 E4) : `POST /api/channels` `{ integration_id, type, sender_identity, project_scope? }` : 201 `{ channel: { id } }`.
 * Le canal naît `pending` ; il passe `active` seulement quand son intégration est vérifiée par le fournisseur (`POST /api/integrations/validate`),
 * ou tout de suite si l'intégration est déjà `active`. Owner et admin ; `Idempotency-Key` obligatoire.
 */
export const POST = withRoute(
  {
    name: "channels.create",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    permission: { action: "connect", resource: "integrations" },
    schema: createChannelSchema,
  },
  async (ctx, input) => {
    const result = await createChannel(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) throw new ServiceError(result.code);
    return { status: 201, body: { channel: { id: result.value.id } } };
  },
);
