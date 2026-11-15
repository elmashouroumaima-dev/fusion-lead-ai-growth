import { setFormKeyOriginsSchema } from "@fusion-leap/domain";
import { setFormKeyOrigins } from "../../../../../lib/forms/service";
import { ServiceError } from "../../../../../lib/service/errors";
import { withRoute } from "../../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/** Remplacer les origines autorisées d'une clé (J39b) : `POST /api/forms/keys/origins` `{ key_id, allowed_origins }`. Owner et admin. Rejouable. */
export const POST = withRoute(
  {
    name: "forms.keys.origins",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    permission: { action: "manage", resource: "form_keys" },
    schema: setFormKeyOriginsSchema,
  },
  async (ctx, input) => {
    const result = await setFormKeyOrigins(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) throw new ServiceError(result.code);
    return { status: 200, body: { updated: true } };
  },
);
