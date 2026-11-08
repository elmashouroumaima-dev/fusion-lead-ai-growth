import { idempotencyKeySchema, type TenantRole } from "@fusion-leap/domain";
import { can, type Action, type PermissionContext, type Resource } from "@fusion-leap/permissions";
import { redirect } from "next/navigation";
import { createClient } from "../supabase/server";
import { assertSameOrganization, getTenantContext, TenantError, type TenantContext } from "../tenant/context";
import { getAuthenticatedUserId, type ServerSupabase } from "../tenant/identity";
import { ServiceError, errorResponse, normalizeError, type ServiceErrorCode } from "./errors";
import { field, toFieldErrors } from "./form";
import {
  canonicalRequestHash,
  errorForDecision,
  IDEMPOTENCY_FIELD,
  IDEMPOTENCY_HEADER,
  idempotencyAbandon,
  idempotencyBegin,
  idempotencyComplete,
  type IdempotencyAttempt,
  type IdempotencyRef,
} from "./idempotency";
import { logger } from "./logger";
import { takeToken, type RateLimitScope } from "./rate-limit";
import { REQUEST_ID_HEADER, resolveRequestIds } from "./request-id";
import { runWithRequestContext, updateRequestContext } from "./request-context";

/*
 * Couche service (J11) : UN pipeline, dans cet ordre fixe, pour toute mutation (route HTTP ou Server Action) :
 *
 *   request_id -> limite de taille -> lecture du corps -> zod -> authentification (claims vérifiés ;
 *   contexte tenant RELU en base) -> comparaison de l'organization_id revendiqué -> can() -> limitation
 *   de débit -> idempotence (begin) -> handler -> idempotence (complete | abandon) -> réponse.
 *
 * Toute erreur est normalisée { code, message, request_id } (jamais de texte brut). Les Server Actions
 * ne renvoient que des codes. Un handler placé sous idempotence ne doit pas appeler redirect() :
 * il renvoie `redirectTo(url)`, exécuté APRÈS la clôture de l'idempotence.
 */

export const DEFAULT_BODY_LIMIT_BYTES = 16 * 1024;

// ---------------------------------------------------------------------------
// Types publics
// ---------------------------------------------------------------------------

/** Schéma structurel (compatible zod) : apps/web n'a pas zod en dépendance directe. */
export type ServiceSchema<T> = {
  safeParse(input: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: ReadonlyArray<{ code: string; path: PropertyKey[] }> } };
};

export type RateLimitOption = RateLimitScope | "none";

/**
 * `required` : sans clé -> validation_failed. `optional` : sans clé, pas d'idempotence.
 * `storeResponse` est OBLIGATOIRE et sans valeur par défaut : chaque action décide explicitement.
 * `storeResponse: false` : seul `{"replayed":true}` est conservé (jamais de secret, ex. jeton d'invitation) ;
 * un rejeu répond alors `duplicate_request` (409) et ne rejoue pas le corps.
 */
export type IdempotencyOption = "none" | { mode: "required" | "optional"; storeResponse: boolean };

/**
 * Champs d'état de formulaire qui portent un secret (lien d'invitation, jeton...). Une réponse qui en
 * contient un n'est JAMAIS conservée en base, quelle que soit l'option `storeResponse` (garde d'exécution).
 */
export const SECRET_STATE_FIELDS: readonly string[] = ["invitePath", "token", "secret", "password"];

export type PermissionOption<T> = { action: Action; resource: Resource; ctx?: (input: T) => PermissionContext };

export type UserServiceContext = {
  requestId: string;
  supabase: ServerSupabase;
  userId: string;
  organizationId: null;
  tenant: null;
};

export type TenantServiceContext = {
  requestId: string;
  supabase: ServerSupabase;
  userId: string;
  organizationId: string;
  role: TenantRole;
  tenant: TenantContext;
};

type CommonOptions<T> = {
  /** Nom stable de l'opération (journaux, empreinte d'idempotence des actions). Aucune donnée variable. */
  name: string;
  schema: ServiceSchema<T>;
  rateLimit: RateLimitOption;
};

type TenantOptions<T> = CommonOptions<T> & {
  auth: "tenant";
  permission?: PermissionOption<T>;
  idempotency: IdempotencyOption;
};

type UserOptions<T> = CommonOptions<T> & {
  auth: "user";
  permission?: undefined;
  /** L'idempotence est rattachée à une organisation : elle n'existe pas sans contexte tenant. */
  idempotency: "none";
  /** Refuse (403) tout `organization_id` présent dans l'entrée : aucune organisation à comparer. */
  forbidOrganizationId?: boolean;
};

// --- Routes ---

/** `text` : réponse texte brute (ex. rapport CSV) ; sans lui, `body` est rendu en JSON. */
export type RouteResult = { status: number; body?: unknown; headers?: Record<string, string>; text?: string };
/** `request` : permet à un handler de lire lui-même un gros corps APRÈS l'authentification, le contrôle de rôle et la limite de débit. */
export type RouteTenantContext = TenantServiceContext & { headers: Headers; request: Request };
export type RouteUserContext = UserServiceContext & { headers: Headers; request: Request };
type RouteExtras = {
  bodyLimitBytes?: number;
  /**
   * Compose l'entrée soumise au schéma à partir du corps JSON et des en-têtes (ex. `Idempotency-Key`) :
   * le schéma valide donc corps ET en-têtes en une seule étape zod, avant l'authentification.
   * Sans cette option, le schéma reçoit le corps seul.
   */
  input?: (body: unknown, headers: Headers) => unknown;
  /**
   * Remplace la lecture JSON du corps (ex. envoi d'un fichier CSV brut, J23). La fonction applique elle-même ses plafonds
   * (`readBoundedBytes`) ; sa valeur est soumise au schéma comme le corps JSON l'aurait été.
   */
  readBody?: (request: Request) => Promise<unknown>;
};

export type TenantRouteOptions<T> = TenantOptions<T> & RouteExtras;
export type UserRouteOptions<T> = UserOptions<T> & RouteExtras;

// --- Server Actions ---

export type ActionStateLike = { status: "idle" | "error" | "success" };
export type ActionFailure = { code: ServiceErrorCode; fieldErrors?: Record<string, string[]> };
export type ActionRedirect = { redirectTo: string };
export type ActionTenantContext = TenantServiceContext & { formData: FormData };
export type ActionUserContext = UserServiceContext & { formData: FormData };

type ActionExtras<S> = {
  /** Champs du formulaire lus (liste fermée : rien d'autre n'atteint le schéma). */
  fields: readonly string[];
  /** Traduit un échec du pipeline en état de formulaire (codes uniquement, jamais de texte). */
  failure: (failure: ActionFailure) => S;
  /**
   * Champs de l'état de SUCCÈS qui portent un secret (ex. `invitePath`). Déclarés ici, ils interdisent
   * `storeResponse: true` : la déclaration de l'action échoue (contrat testé).
   */
  secretFields?: readonly string[];
  /** Destination quand la session est absente ou expirée. */
  loginPath: (formData: FormData) => string;
};

export type TenantActionOptions<T, S> = TenantOptions<T> & ActionExtras<S>;
export type UserActionOptions<T, S> = UserOptions<T> & ActionExtras<S>;

export const redirectTo = (url: string): ActionRedirect => ({ redirectTo: url });

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** redirect() / notFound() de Next lèvent des erreurs de contrôle de flux : elles ne doivent jamais être avalées. */
function isNextControlFlowError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const digest = error.digest;
  return typeof digest === "string" && /^NEXT_(REDIRECT|NOT_FOUND|HTTP_ERROR_FALLBACK)/.test(digest);
}

type Trace = { organizationId?: string; clientRequestId?: string };

/** Registre des actions déclarées (test de contrat : aucune action à secret ne conserve sa réponse). */
export type RegisteredAction = { name: string; storeResponse: boolean | null; secretFields: readonly string[] };
const registry = new Map<string, RegisteredAction>();
export const listRegisteredActions = (): RegisteredAction[] => [...registry.values()];

function registerAction(options: { name: string; idempotency: IdempotencyOption; secretFields?: readonly string[] | undefined }): void {
  const storeResponse = options.idempotency === "none" ? null : options.idempotency.storeResponse;
  const secretFields = options.secretFields ?? [];
  if (storeResponse === true && secretFields.length > 0) {
    throw new Error(`action ${options.name} : storeResponse=true est interdit quand l'état de succès porte un secret (${secretFields.join(", ")})`);
  }
  registry.set(options.name, { name: options.name, storeResponse, secretFields });
}

const carriesSecret = (body: unknown): boolean =>
  isRecord(body) && SECRET_STATE_FIELDS.some((name) => Object.hasOwn(body, name));

/**
 * Une ligne JSON par échec : {event, code, client_request_id?, name} (+ ts, level ; request_id, organization_id et
 * actor_id viennent du contexte de requête, que l'appelant ne peut pas écraser) et RIEN d'autre (ni e-mail, ni jeton, ni empreinte, ni message d'erreur). Les erreurs attendues (4xx)
 * passent par `warn`, les pannes (5xx) par `error`. Le journal (logger.ts) expurge en plus par clé et par valeur.
 */
function logFailure(error: unknown, requestId: string, name: string, trace: Trace): void {
  const { status, body } = normalizeError(error, requestId);
  const fields = {
    code: body.code,
    ...(trace.clientRequestId ? { client_request_id: trace.clientRequestId } : {}),
    name,
  };
  if (status >= 500) logger.error("service_failure", fields);
  else logger.warn("service_failure", fields);
}

/** Tout ce qui n'est pas une ServiceError (ou une TenantError) est une panne interne. */
function toServiceError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  if (error instanceof TenantError) return new ServiceError(error.code === "unauthenticated" ? "unauthenticated" : "forbidden");
  return new ServiceError("internal_error");
}

// ---------------------------------------------------------------------------
// Cœur du pipeline (après lecture et validation de l'entrée)
// ---------------------------------------------------------------------------

type CoreOptions<T> = {
  name: string;
  auth: "tenant" | "user";
  permission?: PermissionOption<T> | undefined;
  rateLimit: RateLimitOption;
  idempotency: IdempotencyOption;
  forbidOrganizationId?: boolean | undefined;
};

type Principal = TenantServiceContext | UserServiceContext;

async function authenticate(auth: "tenant" | "user", requestId: string): Promise<Principal> {
  if (auth === "tenant") {
    let tenant: TenantContext;
    try {
      tenant = await getTenantContext();
    } catch (error) {
      throw toServiceError(error);
    }
    const supabase = await createClient();
    return {
      requestId,
      supabase,
      userId: tenant.userId,
      organizationId: tenant.organizationId,
      role: tenant.role,
      tenant,
    };
  }
  const supabase = await createClient();
  const userId = await getAuthenticatedUserId(supabase);
  if (!userId) throw new ServiceError("unauthenticated");
  return { requestId, supabase, userId, organizationId: null, tenant: null };
}

/** Étape zod : un `organization_id` posté est refusé (403) AVANT toute autre validation quand l'opération n'a pas d'organisation. */
function assertNoOrganizationClaim(raw: unknown, forbidOrganizationId: boolean | undefined): void {
  if (forbidOrganizationId === true && isRecord(raw) && Object.hasOwn(raw, "organization_id")) throw new ServiceError("forbidden");
}

/** Un `organization_id` fourni par le client n'est jamais cru : égal au contexte vérifié, sinon 403. */
function checkOrganizationClaim(principal: Principal, input: unknown, forbidOrganizationId: boolean): void {
  if (!isRecord(input) || !Object.hasOwn(input, "organization_id")) return;
  if (principal.tenant) {
    try {
      assertSameOrganization(principal.tenant, input.organization_id);
    } catch {
      throw new ServiceError("forbidden");
    }
    return;
  }
  if (forbidOrganizationId) throw new ServiceError("forbidden");
}

type Executed<R> =
  | { kind: "replay"; statusCode: number; body: unknown }
  | { kind: "done"; result: R };

type CoreParams<T, R> = {
  options: CoreOptions<T>;
  input: T;
  requestId: string;
  trace: Trace;
  method: string;
  path: string;
  /** Valeur brute de la clé d'idempotence (en-tête ou champ de formulaire). */
  rawKey: string | null | undefined;
  run: (principal: Principal) => Promise<R>;
  /** Faux = l'effet n'a pas eu lieu : la ligne d'idempotence est abandonnée pour autoriser un nouvel essai. */
  isSuccess: (result: R) => boolean;
  serialize: (result: R) => { statusCode: number; body: unknown };
};

async function execute<T, R>(p: CoreParams<T, R>): Promise<Executed<R>> {
  const { options, input, requestId, trace } = p;

  const principal = await authenticate(options.auth, requestId);
  if (principal.organizationId) trace.organizationId = principal.organizationId;
  // Contexte de requête : organisation et acteur désormais vérifiés (journal JSON + audit en base).
  updateRequestContext({ actorId: principal.userId, ...(principal.organizationId ? { organizationId: principal.organizationId } : {}) });
  checkOrganizationClaim(principal, input, options.forbidOrganizationId === true);

  if (options.permission && principal.tenant) {
    const { action, resource, ctx } = options.permission;
    if (!can(principal.tenant.role, action, resource, ctx ? ctx(input) : {})) throw new ServiceError("forbidden");
  }

  if (options.rateLimit !== "none") {
    const taken = await takeToken({
      organizationId: principal.organizationId,
      userId: principal.userId,
      scope: options.rateLimit,
    });
    if (!taken.allowed) throw new ServiceError("rate_limited", { retryAfterSeconds: taken.retryAfterSeconds });
  }

  // --- Idempotence : begin ---
  const idem = options.idempotency;
  let ref: IdempotencyAttempt | null = null;
  if (idem !== "none") {
    const present = p.rawKey !== undefined && p.rawKey !== null && p.rawKey !== "";
    if (present || idem.mode === "required") {
      const key = idempotencyKeySchema.safeParse(p.rawKey ?? undefined);
      if (!key.success) throw new ServiceError("validation_failed");
      if (!principal.organizationId) throw new ServiceError("internal_error");
      const candidate: IdempotencyRef = { organizationId: principal.organizationId, key: key.data };
      const decision = await idempotencyBegin(principal.supabase, {
        ...candidate,
        requestHash: canonicalRequestHash({ method: p.method, path: p.path, body: input }),
      });
      const blocked = errorForDecision(decision);
      if (blocked) throw blocked;
      if (decision.state === "replay") {
        const stored = decision.response;
        // Réponse non conservée (`{"replayed":true}`) : l'effet a eu lieu, le corps ne sera pas rejoué.
        if (!isRecord(stored) || !Object.hasOwn(stored, "body")) throw new ServiceError("duplicate_request");
        return { kind: "replay", statusCode: decision.statusCode, body: stored.body };
      }
      if (decision.state !== "new") throw new ServiceError("internal_error"); // inatteignable : conflict/in_progress/replay traités
      // decision.state === "new" : la tentative est identifiée ; elle seule peut clore ou abandonner la ligne.
      ref = { ...candidate, attemptId: decision.attemptId };
    }
  }

  // --- Handler ---
  let result: R;
  try {
    result = await p.run(principal);
  } catch (error) {
    if (ref) await idempotencyAbandon(principal.supabase, ref);
    throw error;
  }

  // --- Idempotence : complete | abandon ---
  if (ref) {
    if (!p.isSuccess(result)) {
      await idempotencyAbandon(principal.supabase, ref);
    } else {
      const { statusCode, body } = p.serialize(result);
      // Garde d'exécution : un état qui porte un secret n'est jamais conservé, même si l'option le demandait.
      const secret = carriesSecret(body);
      const store = idem !== "none" && idem.storeResponse && !secret;
      if (idem !== "none" && idem.storeResponse && secret) {
        logFailure(new ServiceError("internal_error"), requestId, `${options.name}.secret_state_not_stored`, trace);
      }
      const attempts: unknown[] = store ? [{ body }, { replayed: true }] : [{ replayed: true }];
      let completed = false;
      for (const response of attempts) {
        try {
          await idempotencyComplete(principal.supabase, { ...ref, statusCode, response });
          completed = true;
          break;
        } catch {
          // Réponse trop grosse ou panne : on retente avec la forme minimale, puis on renonce.
        }
      }
      if (!completed) {
        // L'effet a eu lieu : on NE supprime PAS la ligne (un rejeu ré-exécuterait la mutation) ; elle
        // reste « in_progress » et expire au bout de 5 min. La réponse de succès est tout de même rendue.
        logFailure(new ServiceError("internal_error"), requestId, `${options.name}.idempotency_complete`, trace);
      }
    }
  }
  return { kind: "done", result };
}

// ---------------------------------------------------------------------------
// Routes HTTP
// ---------------------------------------------------------------------------

/**
 * Lit le corps en le plafonnant en OCTETS (pas en unités UTF-16). La lecture s'arrête dès le
 * dépassement, sans accumuler le reste du flux.
 */
export async function readBoundedBytes(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared.trim())) throw new ServiceError("validation_failed");
    if (Number(declared) > limit) throw new ServiceError("payload_too_large");
  }
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new ServiceError("payload_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readBoundedText(request: Request, limit: number): Promise<string> {
  return new TextDecoder().decode(await readBoundedBytes(request, limit));
}

/** Taille annoncée (rejet anticipé), type de contenu, lecture plafonnée en octets, JSON. */
export async function readJsonBody(request: Request, limit: number): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared.trim())) throw new ServiceError("validation_failed");
    if (Number(declared) > limit) throw new ServiceError("payload_too_large");
  }
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new ServiceError("validation_failed");
  }
  const text = await readBoundedText(request, limit);
  try {
    return JSON.parse(text);
  } catch {
    throw new ServiceError("validation_failed");
  }
}

function jsonResponse(status: number, body: unknown, requestId: string, extra: Record<string, string> = {}): Response {
  const headers = { ...extra, [REQUEST_ID_HEADER]: requestId, "cache-control": "no-store" };
  if (body === undefined || status === 204) return new Response(null, { status, headers });
  return Response.json(body, { status, headers });
}

export function withRoute<T>(
  options: TenantRouteOptions<T>,
  handler: (ctx: RouteTenantContext, input: T) => Promise<RouteResult>,
): (request: Request) => Promise<Response>;
export function withRoute<T>(
  options: UserRouteOptions<T>,
  handler: (ctx: RouteUserContext, input: T) => Promise<RouteResult>,
): (request: Request) => Promise<Response>;
export function withRoute<T>(
  options: TenantRouteOptions<T> | UserRouteOptions<T>,
  handler: (ctx: never, input: T) => Promise<RouteResult>,
): (request: Request) => Promise<Response> {
  const run = handler as (ctx: RouteTenantContext | RouteUserContext, input: T) => Promise<RouteResult>;

  return function route(request: Request): Promise<Response> {
    const { requestId, clientRequestId } = resolveRequestIds(request.headers);
    // Tout le pipeline (y compris le client Supabase créé en cours de route) s'exécute dans le contexte de requête.
    return runWithRequestContext({ requestId }, () => handleRoute(request, requestId, clientRequestId));
  };

  async function handleRoute(request: Request, requestId: string, clientRequestId: string | undefined): Promise<Response> {
    const trace: Trace = clientRequestId ? { clientRequestId } : {};
    try {
      // 1-2. Taille et corps (les méthodes sans corps lisent la query string).
      const url = new URL(request.url);
      const bodyless = request.method === "GET" || request.method === "HEAD";
      const raw: unknown = bodyless
        ? Object.fromEntries(url.searchParams)
        : options.readBody
          ? await options.readBody(request)
          : await readJsonBody(request, options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES);

      // 3. zod (corps + en-têtes composés par `input`) ; `organization_id` interdit d'abord.
      assertNoOrganizationClaim(raw, "forbidOrganizationId" in options ? options.forbidOrganizationId : undefined);
      const parsed = options.schema.safeParse(options.input ? options.input(raw, request.headers) : raw);
      if (!parsed.success) throw new ServiceError("validation_failed");
      const input = parsed.data;

      // 4-9. auth, organisation revendiquée, can(), débit, idempotence, handler
      const outcome = await execute<T, RouteResult>({
        options,
        input,
        requestId,
        trace,
        method: request.method,
        path: url.pathname,
        rawKey: request.headers.get(IDEMPOTENCY_HEADER),
        run: (principal) => run({ ...principal, headers: request.headers, request } as RouteTenantContext | RouteUserContext, input),
        isSuccess: (result) => result.status < 400,
        serialize: (result) => ({ statusCode: result.status, body: result.body ?? null }),
      });

      if (outcome.kind === "replay") {
        return jsonResponse(outcome.statusCode, outcome.body, requestId, { "idempotent-replay": "true" });
      }
      const { status, body, headers, text } = outcome.result;
      if (text !== undefined) {
        return new Response(text, { status, headers: { ...headers, [REQUEST_ID_HEADER]: requestId, "cache-control": "no-store" } });
      }
      return jsonResponse(status, body, requestId, headers);
    } catch (error) {
      const service = toServiceError(error);
      logFailure(service, requestId, options.name, trace);
      return errorResponse(service, requestId);
    }
  }
}

// ---------------------------------------------------------------------------
// Server Actions
// ---------------------------------------------------------------------------

export function withAction<T, S extends ActionStateLike>(
  options: TenantActionOptions<T, S>,
  handler: (ctx: ActionTenantContext, input: T) => Promise<S | ActionRedirect>,
): (prev: S, formData: FormData) => Promise<S>;
export function withAction<T, S extends ActionStateLike>(
  options: UserActionOptions<T, S>,
  handler: (ctx: ActionUserContext, input: T) => Promise<S | ActionRedirect>,
): (prev: S, formData: FormData) => Promise<S>;
export function withAction<T, S extends ActionStateLike>(
  options: TenantActionOptions<T, S> | UserActionOptions<T, S>,
  handler: (ctx: never, input: T) => Promise<S | ActionRedirect>,
): (prev: S, formData: FormData) => Promise<S> {
  const run = handler as (ctx: ActionTenantContext | ActionUserContext, input: T) => Promise<S | ActionRedirect>;
  registerAction(options);
  const isRedirect = (value: S | ActionRedirect): value is ActionRedirect => Object.hasOwn(value, "redirectTo");

  return function action(_prev: S, formData: FormData): Promise<S> {
    const requestId = crypto.randomUUID();
    return runWithRequestContext({ requestId }, () => handleAction(formData, requestId));
  };

  async function handleAction(formData: FormData, requestId: string): Promise<S> {
    const trace: Trace = {};
    let next: { kind: "state"; state: S } | { kind: "redirect"; url: string };

    try {
      // 3. zod : liste fermée de champs ; erreurs de champ = noms et codes seulement.
      const raw: Record<string, string | undefined> = {};
      for (const name of options.fields) raw[name] = field(formData, name);
      assertNoOrganizationClaim(raw, "forbidOrganizationId" in options ? options.forbidOrganizationId : undefined);
      const parsed = options.schema.safeParse(raw);
      if (!parsed.success) {
        throw new ServiceError("validation_failed", { fieldErrors: toFieldErrors(parsed.error) });
      }
      const input = parsed.data;

      const outcome = await execute<T, S | ActionRedirect>({
        options,
        input,
        requestId,
        trace,
        method: "ACTION",
        path: options.name,
        rawKey: field(formData, IDEMPOTENCY_FIELD),
        run: (principal) => run({ ...principal, formData } as ActionTenantContext | ActionUserContext, input),
        isSuccess: (result) => isRedirect(result) || result.status !== "error",
        serialize: (result) => ({ statusCode: 200, body: isRedirect(result) ? null : result }),
      });

      if (outcome.kind === "replay") {
        const body = outcome.body;
        // Réponse conservée mais illisible : on ne devine rien.
        if (!isRecord(body) || typeof body.status !== "string") throw new ServiceError("duplicate_request");
        next = { kind: "state", state: body as S };
      } else if (isRedirect(outcome.result)) {
        next = { kind: "redirect", url: outcome.result.redirectTo };
      } else {
        next = { kind: "state", state: outcome.result };
      }
    } catch (error) {
      if (isNextControlFlowError(error)) throw error;
      const service = toServiceError(error);
      logFailure(service, requestId, options.name, trace);
      next =
        service.code === "unauthenticated"
          ? { kind: "redirect", url: options.loginPath(formData) }
          : {
              kind: "state",
              state: options.failure({
                code: service.code,
                ...(service.fieldErrors ? { fieldErrors: service.fieldErrors } : {}),
              }),
            };
    }

    // redirect() lève NEXT_REDIRECT : surtout pas dans un try/catch.
    if (next.kind === "redirect") redirect(next.url);
    return next.state;
  }
}
