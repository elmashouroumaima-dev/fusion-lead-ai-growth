import { confirmImportSchema } from "@fusion-leap/domain";
import { confirmImport } from "../../../../lib/imports/service";
import { ServiceError } from "../../../../lib/service/errors";
import { withRoute } from "../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/**
 * Import CSV, étape 3 : `POST /api/imports/confirm` `{ batch_id, mapping, default_country? }`. Enregistre le mapping et enfile le job
 * `import_csv` : le worker crée contacts et leads (jamais dans la requête HTTP). Réponse 202. `Idempotency-Key` obligatoire ; un lot
 * déjà confirmé ou annulé : 409. Owner et admin.
 */
export const POST = withRoute(
  {
    name: "imports.confirm",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    permission: { action: "create", resource: "projects" },
    schema: confirmImportSchema,
  },
  async (ctx, input) => {
    const result = await confirmImport(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) throw new ServiceError(result.code);
    return { status: 202, body: { status: "queued", batch_id: input.batch_id } };
  },
);
