import { deleteAssignmentRuleSchema } from "@fusion-leap/domain";
import { deleteAssignmentRule } from "../../../../../lib/assignment/service";
import { ServiceError } from "../../../../../lib/service/errors";
import { withRoute } from "../../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/** Supprimer une règle (J39b) : `POST /api/assignment/rules/delete` `{ rule_id }`. Owner et admin. Rejouable. */
export const POST = withRoute(
  {
    name: "assignment.rules.delete",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    permission: { action: "manage", resource: "assignment_rules" },
    schema: deleteAssignmentRuleSchema,
  },
  async (ctx, input) => {
    const result = await deleteAssignmentRule(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) throw new ServiceError(result.code);
    return { status: 200, body: { deleted: true } };
  },
);
