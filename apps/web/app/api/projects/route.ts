import { createProjectSchema } from "@fusion-leap/domain";
import { createProject } from "../../../lib/projects/service";
import { ServiceError } from "../../../lib/service/errors";
import { withRoute } from "../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/projects : crée un projet de l'entreprise ACTIVE (spec §8 : « projet après contrôle de la limite du plan »).
 *
 *  - Rôles : owner et admin (matrice ADR 014 : `can(role, "create", "projects")`) ; la fonction SQL revérifie le rôle.
 *  - Corps : `type`, `name`, `settings` (forme selon le type), `owner_id` facultatif (membre actif). Le type
 *    choisit le schéma des réglages ; champ inconnu -> 400. Un `organization_id` dans le corps doit être celui du
 *    contexte vérifié, sinon 403 ; l'entreprise utilisée est TOUJOURS celle du contexte.
 *  - `Idempotency-Key` obligatoire : rejeu identique -> même réponse (`Idempotent-Replay: true`) ; mêmes clé et autres
 *    paramètres -> 422.
 *  - Quota : plan atteint -> 429 `quota_exceeded` (les projets archivés ne comptent pas).
 *  - Corps plafonné à 16 Kio ; erreurs normalisées { code, message, request_id } ; limitation de débit « mutation ».
 */
export const POST = withRoute(
  {
    name: "projects.create",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    permission: { action: "create", resource: "projects" },
    schema: createProjectSchema,
  },
  async (ctx, input) => {
    const result = await createProject(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) throw new ServiceError(result.code);
    return { status: 201, body: { project: result.value } };
  },
);
