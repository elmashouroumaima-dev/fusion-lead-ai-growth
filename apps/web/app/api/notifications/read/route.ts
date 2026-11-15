import { markNotificationReadSchema } from "@fusion-leap/domain";
import { markNotificationRead } from "../../../../lib/assignment/service";
import { ServiceError } from "../../../../lib/service/errors";
import { withRoute } from "../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/**
 * Marquer une notification comme lue (J39b) : `POST /api/notifications/read` `{ notification_id }`. Chaque membre ne lit et ne marque que
 * SES notifications (RLS et fonction SQL) ; pas de permission de matrice (pas de donnée d'autrui). Rejouable.
 */
export const POST = withRoute(
  {
    name: "notifications.read",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    schema: markNotificationReadSchema,
  },
  async (ctx, input) => {
    const result = await markNotificationRead(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) throw new ServiceError(result.code);
    return { status: 200, body: { read: true } };
  },
);
