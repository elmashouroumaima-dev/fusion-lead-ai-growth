import { replayDeadLetterSchema } from "@fusion-leap/domain";
import { replayDeadLetter } from "../../../../../lib/operations/service";
import { ServiceError } from "../../../../../lib/service/errors";
import { withRoute } from "../../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/**
 * Rejeu d'une dead letter (J39) : `POST /api/jobs/dead-letters/replay` `{ job_id }` remet le job en file. Owner et admin. Un job absent de
 * l'entreprise ou qui n'est pas en dead letter répond 404 (sans dire lequel). `Idempotency-Key` obligatoire.
 */
export const POST = withRoute(
  {
    name: "jobs.dead_letters.replay",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    permission: { action: "replay", resource: "dead_letter" },
    schema: replayDeadLetterSchema,
  },
  async (ctx, input) => {
    const result = await replayDeadLetter(ctx.supabase, ctx.organizationId, input.job_id);
    if (!result.ok) throw new ServiceError(result.code);
    if (!result.value) throw new ServiceError("not_found");
    return { status: 200, body: { replayed: true } };
  },
);
