import { createAssignmentRuleSchema } from "@fusion-leap/domain";
import { createAssignmentRule } from "../../../../lib/assignment/service";
import { ServiceError } from "../../../../lib/service/errors";
import { withRoute } from "../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/**
 * Créer une règle d'assignation (J39b, spec §5.3) : `POST /api/assignment/rules` `{ project_id?, strategy, eligible_member_ids }`.
 * `project_id` absent = règle par défaut de l'entreprise. Owner et admin. `Idempotency-Key` obligatoire.
 */
export const POST = withRoute(
  {
    name: "assignment.rules.create",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    permission: { action: "manage", resource: "assignment_rules" },
    schema: createAssignmentRuleSchema,
  },
  async (ctx, input) => {
    const result = await createAssignmentRule(ctx.supabase, ctx.organizationId, input);
    if (!result.ok) throw new ServiceError(result.code);
    return { status: 201, body: { id: result.value.id } };
  },
);
