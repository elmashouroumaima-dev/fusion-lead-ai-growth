import { createHash, createHmac } from "node:crypto";
import type { ServerSupabase } from "../tenant/identity";
import { ServiceError } from "./errors";
import { mapDbError, type DbErrorLike } from "./map-db-error";

/**
 * Idempotence des mutations (ADR 006, ADR 007 `idempotency_keys`).
 *
 * Durées appliquées par la base (fonction `idempotency_begin`) et rappelées ici pour mémoire :
 *  - TTL d'une clé : 24 h (`IDEMPOTENCY_TTL_HOURS`) ; une ligne « completed » expirée est remplacée ;
 *  - un acteur ne détient pas plus de 200 lignes non expirées par organisation (`IDEMPOTENCY_ACTOR_QUOTA`) :
 *    au-delà, `idempotency_begin` lève `quota_exceeded` ;
 *  - une ligne « in_progress » de plus de 5 min (`IDEMPOTENCY_STALE_MINUTES`) est considérée comme
 *    abandonnée (requête ou worker morts) et remplacée : la mutation peut alors être rejouée.
 * Ces constantes ne pilotent pas la base : elles documentent le contrat et servent aux tests.
 */
export const IDEMPOTENCY_TTL_HOURS = 24;
export const IDEMPOTENCY_STALE_MINUTES = 5;
export const IDEMPOTENCY_ACTOR_QUOTA = 200;

/** En-tête des routes HTTP. */
export const IDEMPOTENCY_HEADER = "Idempotency-Key";
/** Champ caché des Server Actions (généré une fois par rendu de formulaire avec crypto.randomUUID()). */
export const IDEMPOTENCY_FIELD = "idempotency_key";

// ---------------------------------------------------------------------------
// Empreinte canonique de la requête
// ---------------------------------------------------------------------------

/**
 * JSON canonique : clés d'objet triées, aucun espace, `undefined` ignoré dans les objets, ordre des
 * tableaux conservé, nombres au format JSON. Les valeurs sont hachées telles quelles (aucune
 * normalisation Unicode). Les valeurs non JSON (bigint, fonction, Date, NaN, Infinity...) sont refusées.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonical_json_non_finite_number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
      }
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new TypeError("canonical_json_unsupported_object");
      const record = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const item = record[key];
        if (item === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new TypeError("canonical_json_unsupported_value");
  }
}

export type RequestHashInput = { method: string; path: string; body: unknown };

/**
 * Remplace, AVANT le calcul de l'empreinte, les champs de premier niveau qui portent un secret (jeton, clé d'API) par leur HMAC-SHA256
 * avec une clé SERVEUR : l'empreinte conservée en base ne permet pas de confirmer une hypothèse sur le secret (il faudrait la clé du
 * serveur), mais deux secrets différents donnent deux empreintes différentes, donc rejouer la même clé d'idempotence avec un AUTRE
 * secret est refusé (idempotency_conflict) au lieu d'être pris pour un rejeu qui n'appliquerait pas le nouveau secret (cas d'une
 * rotation d'urgence).
 */
export function fingerprintSecrets(body: unknown, fields: readonly string[] | undefined, key: string): unknown {
  if (!fields || fields.length === 0 || typeof body !== "object" || body === null || Array.isArray(body)) return body;
  return Object.fromEntries(
    Object.entries(body).map(([name, value]) => [name, fields.includes(name) ? `hmac:${createHmac("sha256", key).update(typeof value === "string" ? value : JSON.stringify(value) ?? "", "utf8").digest("hex")}` : value]),
  );
}

/** SHA-256 hexadécimal (64 minuscules) sur le JSON canonique de { body, method, path }. */
export function canonicalRequestHash({ method, path, body }: RequestHashInput): string {
  const canonical = canonicalJson({ method: method.toUpperCase(), path, body: body === undefined ? null : body });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Décision (fonction pure) à partir de la réponse JSON de `idempotency_begin`
// ---------------------------------------------------------------------------

export type IdempotencyDecision =
  | { state: "new"; attemptId: string }
  | { state: "replay"; statusCode: number; response: unknown }
  | { state: "conflict" }
  | { state: "in_progress" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Interprète la réponse de la base ; toute forme inattendue lève `internal_error` (jamais d'exécution « à l'aveugle »). */
export function decideIdempotency(raw: unknown): IdempotencyDecision {
  if (!isRecord(raw)) throw new ServiceError("internal_error");
  switch (raw.state) {
    case "new": {
      // L'identifiant de tentative est obligatoire : sans lui on ne pourrait ni clore ni abandonner la bonne ligne.
      const attemptId = raw.attempt_id;
      if (typeof attemptId !== "string" || !UUID.test(attemptId)) throw new ServiceError("internal_error");
      return { state: "new", attemptId };
    }
    case "conflict":
      return { state: "conflict" };
    case "in_progress":
      return { state: "in_progress" };
    case "replay": {
      const status = raw.status_code;
      if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
        throw new ServiceError("internal_error");
      }
      return { state: "replay", statusCode: status, response: raw.response };
    }
    default:
      throw new ServiceError("internal_error");
  }
}

/** Erreur à lever pour les décisions qui interdisent l'exécution (null = on peut continuer ou rejouer). */
export function errorForDecision(decision: IdempotencyDecision): ServiceError | null {
  if (decision.state === "conflict") return new ServiceError("idempotency_conflict");
  if (decision.state === "in_progress") return new ServiceError("idempotency_in_progress");
  return null;
}

// ---------------------------------------------------------------------------
// Appels RPC (client de l'UTILISATEUR : l'identité est auth.uid(), jamais un paramètre)
// ---------------------------------------------------------------------------

type RpcResult = { data: unknown; error: DbErrorLike | null };

async function callRpc(supabase: ServerSupabase, name: string, args: Record<string, unknown>): Promise<RpcResult> {
  try {
    const { data, error } = await supabase.rpc(name, args);
    return { data, error };
  } catch {
    return { data: null, error: { code: "XX000" } };
  }
}

export type IdempotencyRef = { organizationId: string; key: string };
/**
 * Une tentative = une prise de la clé (`attempt_id` renvoyé par `idempotency_begin`). Une tentative
 * tardive (ligne reprise entre-temps par une autre) ne peut ni clore ni supprimer la ligne de la nouvelle.
 */
export type IdempotencyAttempt = IdempotencyRef & { attemptId: string };

export async function idempotencyBegin(
  supabase: ServerSupabase,
  ref: IdempotencyRef & { requestHash: string },
): Promise<IdempotencyDecision> {
  const { data, error } = await callRpc(supabase, "idempotency_begin", {
    p_org: ref.organizationId,
    p_key: ref.key,
    p_request_hash: ref.requestHash,
  });
  if (error) throw new ServiceError(mapDbError(error));
  return decideIdempotency(data);
}

export async function idempotencyComplete(
  supabase: ServerSupabase,
  ref: IdempotencyAttempt & { statusCode: number; response: unknown },
): Promise<void> {
  const { error } = await callRpc(supabase, "idempotency_complete", {
    p_org: ref.organizationId,
    p_key: ref.key,
    p_attempt_id: ref.attemptId,
    p_status_code: ref.statusCode,
    p_response: ref.response,
  });
  if (error) throw new ServiceError(mapDbError(error));
}

/**
 * Supprime la ligne `in_progress` de CETTE tentative pour qu'un rejeu puisse ré-exécuter (sans effet si la
 * ligne appartient à une autre tentative). Best effort : n'échoue jamais.
 */
export async function idempotencyAbandon(supabase: ServerSupabase, ref: IdempotencyAttempt): Promise<void> {
  await callRpc(supabase, "idempotency_abandon", { p_org: ref.organizationId, p_key: ref.key, p_attempt_id: ref.attemptId });
}
