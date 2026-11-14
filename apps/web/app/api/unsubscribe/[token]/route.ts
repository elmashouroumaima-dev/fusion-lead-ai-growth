import { DEFAULT_LOCALE } from "@fusion-leap/domain";
import { getServerEnv } from "../../../../lib/env/server";
import { clientIp, ipBucketKey } from "../../../../lib/service/capture-lead";
import { logger } from "../../../../lib/service/logger";
import { takePublicToken } from "../../../../lib/service/rate-limit";
import { runWithRequestContext } from "../../../../lib/service/request-context";
import { resolveRequestIds } from "../../../../lib/service/request-id";
import { applyUnsubscribe, isValidUnsubscribeToken, UNSUBSCRIBE_TOKEN_SHAPE } from "../../../../lib/service/unsubscribe";
import { ServiceError } from "../../../../lib/service/errors";
import { readBoundedBytes } from "../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } as const;
const json = (status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...noStore, ...extra } });

/**
 * GET /api/unsubscribe/[token] : le lien du pied de page. Il NE désabonne PAS (les outils de sécurité des messageries ouvrent les liens) :
 * il renvoie vers la page de confirmation, sur le site configuré (jamais l'hôte de la requête).
 */
export async function GET(_request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await context.params;
  if (!UNSUBSCRIBE_TOKEN_SHAPE.test(token)) return new Response(null, { status: 404, headers: noStore });
  const target = new URL(`/${DEFAULT_LOCALE}/unsubscribe/${token}`, getServerEnv().SITE_URL);
  return new Response(null, { status: 302, headers: { Location: target.toString(), ...noStore } });
}

/**
 * POST /api/unsubscribe/[token] : désabonnement en un clic (RFC 8058, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`), sans session.
 * Le corps doit être `List-Unsubscribe=One-Click` (corps minuscule, lu avec plafond). Idempotent ; 400 pour un jeton invalide, 429 au-delà
 * de la limite par adresse, 503 si la base ou la clé sont indisponibles (le fournisseur de messagerie peut réessayer).
 */
export async function POST(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  const { requestId } = resolveRequestIds(request.headers);
  const { token } = await context.params;
  return runWithRequestContext({ requestId }, async () => {
    try {
      // forme et signature d'abord (aucun accès base) : un jeton inventé ne coûte ni écriture ni jeton de limitation
      if (!isValidUnsubscribeToken(token)) return json(400, { code: "invalid_link", request_id: requestId });
      const limit = await takePublicToken({ scope: "unsubscribe_ip", bucketKey: ipBucketKey(clientIp(request.headers) ?? "unknown") });
      if (!limit.allowed) return json(429, { code: "rate_limited", request_id: requestId }, { "Retry-After": String(limit.retryAfterSeconds) });
      const body = new TextDecoder().decode(await readBoundedBytes(request, 512));
      if (new URLSearchParams(body).get("List-Unsubscribe") !== "One-Click") return json(400, { code: "invalid_request", request_id: requestId });
      const outcome = await applyUnsubscribe(token);
      if (outcome === "invalid") return json(400, { code: "invalid_link", request_id: requestId });
      logger.info("unsubscribe.applied", { outcome });
      return json(200, { ok: true });
    } catch (error) {
      // corps trop gros ou mal formé : requête invalide ; tout le reste (base, clé) : le fournisseur de messagerie réessaiera
      if (error instanceof ServiceError && (error.code === "validation_failed" || error.code === "payload_too_large")) return json(400, { code: "invalid_request", request_id: requestId });
      return json(503, { code: "service_unavailable", request_id: requestId }, { "Retry-After": "30" });
    }
  });
}
