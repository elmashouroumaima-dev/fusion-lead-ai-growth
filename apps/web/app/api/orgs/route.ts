import { createOrganizationApiSchema, idempotencyKeySchema } from "@fusion-leap/domain";
import { apiError } from "../../../lib/api/errors";
import { getRequestId, REQUEST_ID_HEADER } from "../../../lib/api/request-id";
import { createClient } from "../../../lib/supabase/server";
import { setActiveOrgCookie } from "../../../lib/tenant/active-org-cookie";
import { createOrganizationForUser } from "../../../lib/tenant/create-organization";
import { getAuthenticatedUserId } from "../../../lib/tenant/identity";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024; // 16384 octets

/**
 * Lit le corps en le plafonnant en OCTETS (pas en unités UTF-16). `null` = plafond dépassé :
 * la lecture s'arrête dès le dépassement, sans accumuler le reste du flux.
 */
async function readBoundedBody(request: Request): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * POST /api/orgs : crée une organisation (+ membre owner + abonnement trial) de façon atomique
 * via la fonction SQL, avec les droits de l'utilisateur.
 *
 *  - Idempotency-Key obligatoire (8..128, [A-Za-z0-9_-]) : rejeu identique -> 200 même corps ;
 *    même clé avec d'autres paramètres -> 422 idempotency_conflict.
 *  - Un `organization_id` dans le corps est REFUSÉ (403) : un client ne choisit jamais d'id.
 *  - CSRF : en-tête personnalisé `Idempotency-Key` + `Content-Type: application/json` imposent un
 *    préflight CORS pour tout appel inter-origine ; les cookies sont SameSite=Lax.
 *  - Corps plafonné à 16 Kio (Content-Length annoncé, puis octets lus) -> 413 ; champs inconnus -> 400.
 *  - Erreurs normalisées { code, message, request_id }, sans trace ni message SQL.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request.headers);

  try {
    const supabase = await createClient();
    const userId = await getAuthenticatedUserId(supabase);
    if (!userId) return apiError("unauthenticated", requestId);

    const key = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
    if (!key.success) return apiError("validation_failed", requestId);

    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return apiError("validation_failed", requestId);
    }

    // Rejet anticipé sur la taille annoncée, puis plafond réel en octets pendant la lecture.
    const declared = request.headers.get("content-length");
    if (declared !== null) {
      if (!/^\d+$/.test(declared.trim())) return apiError("validation_failed", requestId);
      if (Number(declared) > MAX_BODY_BYTES) return apiError("payload_too_large", requestId);
    }
    const text = await readBoundedBody(request);
    if (text === null) return apiError("payload_too_large", requestId);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return apiError("validation_failed", requestId);
    }
    if (!isRecord(raw)) return apiError("validation_failed", requestId);

    // Un client ne choisit jamais d'identifiant d'organisation (ADR 005 §7) : refus net, même identique.
    if (Object.hasOwn(raw, "organization_id")) return apiError("forbidden", requestId);

    // Champs inconnus (role, slug, created_by...) : refus net, jamais ignorés en silence.
    const input = createOrganizationApiSchema.safeParse(raw);
    if (!input.success) return apiError("validation_failed", requestId);

    const result = await createOrganizationForUser(supabase, userId, input.data, key.data, requestId);
    if (!result.ok) return apiError(result.code, requestId);

    // Organisation désormais vérifiée comme appartenant à l'utilisateur : le cookie reste un indice.
    await setActiveOrgCookie(result.organization.id);

    return Response.json(
      { organization: result.organization, role: result.role },
      {
        status: result.created ? 201 : 200,
        headers: { [REQUEST_ID_HEADER]: requestId, "cache-control": "no-store" },
      },
    );
  } catch {
    console.error(JSON.stringify({ event: "orgs_post_failed", request_id: requestId }));
    return apiError("internal_error", requestId);
  }
}
