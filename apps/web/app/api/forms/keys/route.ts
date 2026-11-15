import { createFormKeySchema } from "@fusion-leap/domain";
import { createFormKey } from "../../../../lib/forms/service";
import { ServiceError } from "../../../../lib/service/errors";
import { withRoute } from "../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/**
 * Créer une clé de formulaire (J39b, ADR 007) : `POST /api/forms/keys` `{ project_id, allowed_origins }`. La réponse 201 est le SEUL endroit
 * où la clé en clair existe : `{ id, key, key_prefix }`. Elle n'est ni relue, ni journalisée, ni conservée par l'idempotence
 * (`storeResponse: false` : un rejeu avec la même clé répond 409 `duplicate_request` sans corps). Owner et admin. `Idempotency-Key` obligatoire.
 */
export const POST = withRoute(
  {
    name: "forms.keys.create",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: false },
    permission: { action: "manage", resource: "form_keys" },
    schema: createFormKeySchema,
  },
  async (ctx, input) => {
    const result = await createFormKey(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) throw new ServiceError(result.code);
    return { status: 201, body: { id: result.value.id, key: result.value.key, key_prefix: result.value.keyPrefix } };
  },
);
