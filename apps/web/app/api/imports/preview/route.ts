import { confirmImportSchema } from "@fusion-leap/domain";
import { previewImport } from "../../../../lib/imports/service";
import { ServiceError } from "../../../../lib/service/errors";
import { withRoute } from "../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/**
 * Import CSV, étape 2 : `POST /api/imports/preview` `{ batch_id, mapping, default_country? }`. Mapping des colonnes (rang à partir de 0)
 * + aperçu des 20 premières lignes + rapport de déduplication (nouveaux, déjà connus, doublons dans le fichier, erreurs par ligne).
 * N'ÉCRIT RIEN : ni contact, ni lead, ni consentement. Owner et admin ; lot « envoyé » seulement (sinon 409).
 */
export const POST = withRoute(
  {
    name: "imports.preview",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: "none",
    permission: { action: "create", resource: "projects" },
    schema: confirmImportSchema,
  },
  async (ctx, input) => {
    const result = await previewImport(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) throw new ServiceError(result.code);
    return { status: 200, body: { preview: result.value } };
  },
);
