import { CAPTURE_BODY_MAX_BYTES, capturePayloadSchema, formKeySchema } from "@fusion-leap/domain";
import { captureLead, clientIp, hashFormKey, ipBucketKey, isFormKeyOriginOk, isOriginAllowed } from "../../../lib/service/capture-lead";
import { errorResponse, ServiceError } from "../../../lib/service/errors";
import { logger } from "../../../lib/service/logger";
import { takePublicToken } from "../../../lib/service/rate-limit";
import { REQUEST_ID_HEADER, resolveRequestIds } from "../../../lib/service/request-id";
import { runWithRequestContext } from "../../../lib/service/request-context";
import { readJsonBody } from "../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/leads : capture PUBLIQUE d'un lead depuis le formulaire d'un site (spec §9.1, J21). Route SANS session : la clé de
 * formulaire (en-tête `X-Form-Key`) donne l'entreprise et le projet, l'origine du navigateur (`Origin`) doit être l'une des
 * origines de la clé.
 *
 *  - Ordre : origine présente -> limitation de débit par adresse -> forme de la clé -> clé active ET origine DE CETTE clé (aucune
 *    écriture) -> limitation de débit par clé (seulement pour une clé qui existe) -> corps (16 Kio, JSON strict) -> champ piège ->
 *    écriture (une transaction : contact, lead, consentement, job d'assignation). L'adresse du visiteur est l'élément de
 *    `x-forwarded-for` à `TRUSTED_PROXY_HOPS` rangs en partant de la droite (ADR 010).
 *  - Réponse IDENTIQUE pour un nouveau contact et un doublon (`202 { status: "received" }`), sans identifiant : la route ne
 *    révèle jamais si une adresse est déjà dans le CRM. Champ piège rempli : même réponse, rien n'est écrit.
 *  - Clé invalide, inactive, origine refusée, projet archivé : un seul refus (403 `forbidden`), sans indication de la cause.
 *  - Quota « contacts » ou abonnement : 429 `quota_exceeded` ; limitation de débit : 429 `rate_limited` + `Retry-After`.
 *  - Aucune donnée personnelle dans les journaux. Pas de cookie : CORS sans identifiants, uniquement pour une origine autorisée.
 *  - Pas d'Idempotency-Key (formulaire public) : le modèle de données dédoublonne (un contact, un lead ouvert par projet).
 */
const received = { status: "received" } as const;

const corsHeaders = (origin: string): Record<string, string> => ({ "access-control-allow-origin": origin, vary: "Origin" });

export async function OPTIONS(request: Request): Promise<Response> {
  const { requestId } = resolveRequestIds(request.headers);
  const origin = request.headers.get("origin");
  const refuse = (status: number, extra: Record<string, string> = {}) =>
    new Response(null, { status, headers: { vary: "Origin", "cache-control": "no-store", [REQUEST_ID_HEADER]: requestId, ...extra } });
  try {
    // Le préflight est limité par adresse AVANT toute lecture de la base (pas d'amplification ni d'énumération des origines).
    const ip = clientIp(request.headers);
    const limit = await takePublicToken({ scope: "capture_preflight", bucketKey: ipBucketKey(ip ?? "unknown") });
    if (!limit.allowed) return refuse(429, { "retry-after": String(limit.retryAfterSeconds) });
  } catch {
    return refuse(503);
  }
  if (!origin || !(await isOriginAllowed(origin))) return refuse(403);
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin),
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-form-key, x-request-id",
      "access-control-max-age": "600",
      "cache-control": "no-store",
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  const { requestId, clientRequestId } = resolveRequestIds(request.headers);
  return runWithRequestContext({ requestId }, async () => {
    const origin = request.headers.get("origin");
    let cors: Record<string, string> = { vary: "Origin" };
    try {
      if (!origin) throw new ServiceError("forbidden");

      const ip = clientIp(request.headers);
      const byIp = await takePublicToken({ scope: "capture_ip", bucketKey: ipBucketKey(ip ?? "unknown") });
      if (!byIp.allowed) throw new ServiceError("rate_limited", { retryAfterSeconds: byIp.retryAfterSeconds });

      const key = formKeySchema.safeParse(request.headers.get("x-form-key") ?? "");
      if (!key.success) throw new ServiceError("forbidden");
      const keyHash = hashFormKey(key.data);
      // La clé doit exister, être active, et l'origine doit être celle de CETTE clé : sinon le même refus, sans CORS ni seau créé.
      if (!(await isFormKeyOriginOk(keyHash, origin))) throw new ServiceError("forbidden");
      cors = corsHeaders(origin);
      const byKey = await takePublicToken({ scope: "capture_key", bucketKey: keyHash.slice(0, 32) });
      if (!byKey.allowed) throw new ServiceError("rate_limited", { retryAfterSeconds: byKey.retryAfterSeconds });

      const parsed = capturePayloadSchema.safeParse(await readJsonBody(request, CAPTURE_BODY_MAX_BYTES));
      if (!parsed.success) throw new ServiceError("validation_failed");
      if (parsed.data.honeypot) {
        logger.info("capture.honeypot", { request_id: requestId });
        return Response.json(received, { status: 202, headers: { ...cors, [REQUEST_ID_HEADER]: requestId, "cache-control": "no-store" } });
      }

      const result = await captureLead({ keyHash, origin, ip, payload: parsed.data });
      logger.info("capture.accepted", {
        request_id: requestId,
        ...(clientRequestId ? { client_request_id: clientRequestId } : {}),
        contact_created: result.contactCreated,
        lead_created: result.leadCreated,
        consent_recorded: result.consentRecorded,
      });
      return Response.json(received, { status: 202, headers: { ...cors, [REQUEST_ID_HEADER]: requestId, "cache-control": "no-store" } });
    } catch (error) {
      const response = errorResponse(error, requestId);
      for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
      return response;
    }
  });
}
