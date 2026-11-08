import { moveDealStageSchema } from "@fusion-leap/domain";
import { moveDealStage } from "../../../../lib/leads/service";
import { ServiceError } from "../../../../lib/service/errors";
import { withRoute } from "../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/**
 * Tableau des deals (J24) : `POST /api/deals/move` `{ deal_id, stage_id }` déplace un deal vers une étape de SON pipeline (le
 * glisser-déposer et le menu clavier passent tous deux par ici, puis par la fonction `move_deal_stage` du J19 : la base valide le
 * rôle, la propriété du lead, l'étape et les dates gagné / perdu). Rôles (ADR 014 ligne 14) : owner et admin sur tous les deals,
 * commercial sur les siens (la base et la RLS le vérifient : un deal d'un autre est « introuvable »), marketing et analyste : 403.
 * `Idempotency-Key` obligatoire. L'entreprise est celle du contexte (un `organization_id` dans le corps doit lui être égal).
 */
export const POST = withRoute(
  {
    name: "deals.move",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    // `isOwnRecord: true` : la propriété du deal n'est connue que de la base (RLS + fonction SQL) ; la matrice écarte déjà
    // marketing et analyste, et la base refuse le commercial qui n'est pas responsable du lead.
    permission: { action: "change_stage", resource: "deals", ctx: () => ({ isOwnRecord: true }) },
    schema: moveDealStageSchema,
  },
  async (ctx, input) => {
    const result = await moveDealStage(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) throw new ServiceError(result.code);
    return { status: 200, body: { deal: result.value } };
  },
);
