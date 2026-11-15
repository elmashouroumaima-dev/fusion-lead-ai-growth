import { updateAssignmentRuleSchema } from "@fusion-leap/domain";
import { updateAssignmentRule } from "../../../../../lib/assignment/service";
import { ServiceError } from "../../../../../lib/service/errors";
import { withRoute } from "../../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/** Modifier une règle (J39b) : `POST /api/assignment/rules/update` `{ rule_id, strategy, eligible_member_ids, active }`. Owner et admin. Rejouable. */
export const POST = withRoute(
  {
    name: "assignment.rules.update",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    permission: { action: "manage", resource: "assignment_rules" },
    schema: updateAssignmentRuleSchema,
  },
  async (ctx, input) => {
    const result = await updateAssignmentRule(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) throw new ServiceError(result.code);
    return { status: 200, body: { updated: true } };
  },
);
