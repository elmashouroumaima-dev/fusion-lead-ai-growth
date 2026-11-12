import { cancelImportSchema } from "@fusion-leap/domain";
import { cancelImport } from "../../../../lib/imports/service";
import { ServiceError } from "../../../../lib/service/errors";
import { withRoute } from "../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/** Import CSV : `POST /api/imports/cancel` `{ batch_id }` annule un lot « envoyé » ou « en file ». `Idempotency-Key` obligatoire. Owner et admin. */
export const POST = withRoute(
  {
    name: "imports.cancel",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    permission: { action: "create", resource: "projects" },
    schema: cancelImportSchema,
  },
  async (ctx, input) => {
    const result = await cancelImport(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) throw new ServiceError(result.code);
    return { status: 200, body: { status: "cancelled", batch_id: input.batch_id } };
  },
);
