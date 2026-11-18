import { updateChannelSchema } from "@fusion-leap/domain";
import { updateChannel } from "../../../../lib/integrations/service";
import { ServiceError } from "../../../../lib/service/errors";
import { withRoute } from "../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/** Modifier un canal : `POST /api/channels/update` `{ channel_id, project_scope?, send_paused? }` (pause d'envoi, portée par projets). Owner et admin ; `Idempotency-Key` obligatoire. */
export const POST = withRoute(
  {
    name: "channels.update",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    permission: { action: "connect", resource: "integrations" },
    schema: updateChannelSchema,
  },
  async (ctx, input) => {
    const result = await updateChannel(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) throw new ServiceError(result.code);
    return { status: 200, body: { updated: true } };
  },
);
