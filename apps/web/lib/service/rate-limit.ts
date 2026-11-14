import { createAdminClient } from "../supabase/admin";
import { ServiceError } from "./errors";

/**
 * Limitation de débit par seau à jetons en base (ADR 007 G-D9, table `rate_limit_buckets`), écrite
 * UNIQUEMENT par service_role depuis le serveur (fonction `rate_limit_take`).
 *
 *  - `mutation`  : capacité 30, recharge 0,5 jeton/s  (30 écritures en rafale, puis 1 toutes les 2 s) ;
 *  - `sensitive` : capacité 10, recharge 1/6 jeton/s  (10 en rafale, puis 1 toutes les 6 s) :
 *    création d'organisation, invitation, transfert de propriété, changement de rôle, retrait de
 *    membre, révocation d'invitation.
 * Clés des seaux : (organisation, utilisateur) ET utilisateur global (voir `takeToken`). Les limites par IP ne sont PAS construites (J21).
 * Défaillance du backend : FERMÉE (`service_unavailable`, 503), aucune mutation n'est exécutée.
 */
export const LIMITS = {
  mutation: { capacity: 30, refillPerSecond: 0.5 },
  sensitive: { capacity: 10, refillPerSecond: 1 / 6 },
} as const;

export type RateLimitScope = keyof typeof LIMITS;

/**
 * Sans organisation (création d'organisation, changement d'organisation active), le contrat SQL exige
 * `organization_id` OU `provider` : ce nom de portée « par utilisateur » est alors passé en `provider`.
 */
export const USER_SCOPE_PROVIDER = "user_scope";

export type TakeTokenInput = {
  organizationId: string | null;
  userId: string;
  scope: RateLimitScope;
};

export type TakeTokenResult = { allowed: boolean; retryAfterSeconds: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Bucket = { organizationId: string | null; bucketKey: string };

/** Un appel `rate_limit_take` ; toute défaillance (réseau, SQL, forme) lève `service_unavailable` (échec fermé). */
async function takeFromBucket({ organizationId, bucketKey }: Bucket, scope: RateLimitScope): Promise<TakeTokenResult> {
  const limit = LIMITS[scope];
  let data: unknown;
  try {
    const result = await createAdminClient().rpc("rate_limit_take", {
      p_org: organizationId,
      p_provider: organizationId === null ? USER_SCOPE_PROVIDER : null,
      p_bucket_key: bucketKey,
      p_capacity: limit.capacity,
      p_refill_per_second: limit.refillPerSecond,
      p_cost: 1,
    });
    if (result.error) throw new Error("rate_limit_backend_error");
    data = result.data;
  } catch {
    // Échec fermé : la cause (réseau, configuration, SQL) n'est pas distinguée vers l'extérieur.
    throw new ServiceError("service_unavailable");
  }

  if (!isRecord(data) || typeof data.allowed !== "boolean") throw new ServiceError("service_unavailable");
  if (data.allowed) return { allowed: true, retryAfterSeconds: 0 };
  const retry = data.retry_after_seconds;
  const retryAfterSeconds = typeof retry === "number" && Number.isFinite(retry) && retry >= 1 ? Math.ceil(retry) : 1;
  return { allowed: false, retryAfterSeconds };
}

/**
 * Prend un jeton dans le seau (organisation, utilisateur), PUIS un second dans le seau GLOBAL de
 * l'utilisateur (sans organisation, provider `user_scope`, mêmes capacité et recharge) : un utilisateur
 * membre de plusieurs organisations ne multiplie donc pas son quota. Les deux doivent accepter ; sinon
 * refus avec le plus grand `Retry-After`. Sans organisation, le seau (organisation, utilisateur) EST déjà
 * le seau global : un seul jeton est pris. Les deux seaux sont toujours interrogés (même si le premier
 * refuse) pour renvoyer le délai d'attente réel ; une panne de l'un ou l'autre est un échec fermé (503).
 *
 * `bucket_key` = portée + ":" + uuid de l'utilisateur : opaque, sans e-mail ni autre donnée
 * personnelle (la base ne doit jamais recevoir de PII dans cette clé).
 */
export async function takeToken({ organizationId, userId, scope }: TakeTokenInput): Promise<TakeTokenResult> {
  const bucketKey = `${scope}:${userId}`;
  const first = await takeFromBucket({ organizationId, bucketKey }, scope);
  if (organizationId === null) return first;
  const global = await takeFromBucket({ organizationId: null, bucketKey }, scope);
  if (first.allowed && global.allowed) return { allowed: true, retryAfterSeconds: 0 };
  return { allowed: false, retryAfterSeconds: Math.max(first.retryAfterSeconds, global.retryAfterSeconds) };
}

/**
 * Limitation de débit des routes PUBLIQUES (J21 : capture de leads), sans session ni organisation connue d'avance : seaux
 * GLOBAUX par fournisseur (`public_capture`, organisation NULL, ADR 007 G-D9).
 *  - `capture_ip`  : capacité 20, recharge 1/3 jeton/s (20 en rafale, puis 20 par minute) ;
 *  - `capture_preflight` : capacité 60, recharge 1 jeton/s (préflight CORS, par adresse) ;
 *  - `capture_key` : capacité 200, recharge 2 jetons/s (une clé de formulaire ne peut pas saturer la base) ; ce seau n'est ouvert
 *    que pour une clé qui EXISTE (aucune ligne pour une clé inventée).
 * La clé de seau est opaque (empreinte, jamais d'adresse IP ni d'e-mail en clair). Défaillance du backend : FERMÉE (503).
 */
export const PUBLIC_CAPTURE_PROVIDER = "public_capture";
export const PUBLIC_LIMITS = {
  capture_ip: { capacity: 20, refillPerSecond: 1 / 3 },
  /** Préflight CORS : un par envoi de formulaire, donc un seau à part (il ne consomme pas le budget des envois). */
  capture_preflight: { capacity: 60, refillPerSecond: 1 },
  capture_key: { capacity: 200, refillPerSecond: 2 },
  /** Webhooks entrants (J29), par fournisseur et adresse source : les fournisseurs envoient en rafale depuis peu d'adresses. */
  webhook_ip: { capacity: 300, refillPerSecond: 10 },
  /** Désabonnement public (J33) : un jeton signé est exigé, la limite protège seulement la base ; les messageries envoient le un-clic depuis peu d'adresses. */
  unsubscribe_ip: { capacity: 120, refillPerSecond: 2 },
} as const;
export type PublicRateLimitScope = keyof typeof PUBLIC_LIMITS;

export async function takePublicToken({ scope, bucketKey }: { scope: PublicRateLimitScope; bucketKey: string }): Promise<TakeTokenResult> {
  const limit = PUBLIC_LIMITS[scope];
  let data: unknown;
  try {
    const result = await createAdminClient().rpc("rate_limit_take", {
      p_org: null,
      p_provider: PUBLIC_CAPTURE_PROVIDER,
      p_bucket_key: `${scope}:${bucketKey}`,
      p_capacity: limit.capacity,
      p_refill_per_second: limit.refillPerSecond,
      p_cost: 1,
    });
    if (result.error) throw new Error("rate_limit_backend_error");
    data = result.data;
  } catch {
    throw new ServiceError("service_unavailable");
  }
  if (!isRecord(data) || typeof data.allowed !== "boolean") throw new ServiceError("service_unavailable");
  if (data.allowed) return { allowed: true, retryAfterSeconds: 0 };
  const retry = data.retry_after_seconds;
  return { allowed: false, retryAfterSeconds: typeof retry === "number" && Number.isFinite(retry) && retry >= 1 ? Math.ceil(retry) : 1 };
}
