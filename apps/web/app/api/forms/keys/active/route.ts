import { setFormKeyActiveSchema } from "@fusion-leap/domain";
import { setFormKeyActive } from "../../../../../lib/forms/service";
import { ServiceError } from "../../../../../lib/service/errors";
import { withRoute } from "../../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/** Révoquer (`active: false`) ou réactiver une clé de formulaire (J39b) : `POST /api/forms/keys/active`. Owner et admin. Rejouable. */
export const POST = withRoute(
  {
    name: "forms.keys.active",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    permission: { action: "manage", resource: "form_keys" },
    schema: setFormKeyActiveSchema,
  },
  async (ctx, input) => {
    const result = await setFormKeyActive(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) throw new ServiceError(result.code);
    return { status: 200, body: { active: input.active } };
  },
);
