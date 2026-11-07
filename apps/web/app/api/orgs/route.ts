import { createOrganizationApiSchema, idempotencyKeySchema, type CreateOrganizationInput } from "@fusion-leap/domain";
import { ServiceError } from "../../../lib/service/errors";
import { IDEMPOTENCY_HEADER } from "../../../lib/service/idempotency";
import { withRoute, type ServiceSchema } from "../../../lib/service/with-service";
import { setActiveOrgCookie } from "../../../lib/tenant/active-org-cookie";
import { createOrganizationForUser } from "../../../lib/tenant/create-organization";

export const dynamic = "force-dynamic";

type CreateOrganizationRouteInput = { organization: CreateOrganizationInput; creationKey: string };

/**
 * Étape zod UNIQUE (avant l'authentification, ordre du contrat) : `Idempotency-Key` (en-tête, composé par
 * `input` ci-dessous) ET corps, ce dernier avec le schéma métier STRICT. Un `organization_id` dans le corps
 * est refusé en amont par le pipeline (`forbidOrganizationId`, 403, avant toute autre validation).
 */
const createOrganizationRouteSchema: ServiceSchema<CreateOrganizationRouteInput> = {
  safeParse(raw) {
    const { body, idempotencyKey } = raw as { body: unknown; idempotencyKey: string | null };
    const key = idempotencyKeySchema.safeParse(idempotencyKey ?? undefined);
    if (!key.success) return { success: false, error: { issues: key.error.issues } };
    const input = createOrganizationApiSchema.safeParse(body);
    if (!input.success) return { success: false, error: { issues: input.error.issues } };
    return { success: true, data: { organization: input.data, creationKey: key.data } };
  },
};

/**
 * POST /api/orgs : crée une organisation (+ membre owner + abonnement trial) de façon atomique
 * via la fonction SQL, avec les droits de l'utilisateur.
 *
 *  - Idempotency-Key obligatoire (8..128, [A-Za-z0-9_-]) : c'est la clé de création propre au RPC
 *    (`creation_key`) ; rejeu identique -> 200 même corps ; mêmes clé et autres paramètres -> 422
 *    idempotency_conflict. La table d'idempotence générique n'est donc pas utilisée ici (`none`).
 *  - Un `organization_id` dans le corps est REFUSÉ (403) : un client ne choisit jamais d'id.
 *  - CSRF : en-tête personnalisé `Idempotency-Key` + `Content-Type: application/json` imposent un
 *    préflight CORS pour tout appel inter-origine ; les cookies sont SameSite=Lax.
 *  - Corps plafonné à 16 Kio (octets) -> 413 ; champs inconnus -> 400 ; limite de débit « sensible ».
 *  - Erreurs normalisées { code, message, request_id }, sans trace ni message SQL.
 */
export const POST = withRoute(
  {
    name: "orgs.create",
    auth: "user",
    rateLimit: "sensitive",
    idempotency: "none",
    forbidOrganizationId: true,
    input: (body, headers) => ({ body, idempotencyKey: headers.get(IDEMPOTENCY_HEADER) }),
    schema: createOrganizationRouteSchema,
  },
  async (ctx, { organization, creationKey }) => {
    const result = await createOrganizationForUser(ctx.supabase, ctx.userId, organization, creationKey, ctx.requestId);
    if (!result.ok) throw new ServiceError(result.code);

    // Organisation désormais vérifiée comme appartenant à l'utilisateur : le cookie reste un indice.
    await setActiveOrgCookie(result.organization.id);

    return {
      status: result.created ? 201 : 200,
      body: { organization: result.organization, role: result.role },
    };
  },
);
