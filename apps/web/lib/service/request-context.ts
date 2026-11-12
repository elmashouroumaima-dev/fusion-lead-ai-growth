import { AsyncLocalStorage } from "node:async_hooks";
import { REQUEST_ID_HEADER } from "./request-id";

/*
 * Contexte de requête (J12) : propagé par AsyncLocalStorage à travers tous les `await` d'une requête,
 * sans jamais fuir vers une requête concurrente (chaque `run` a son propre magasin).
 *
 * `requestId` est TOUJOURS l'identifiant généré côté serveur (jamais celui du client) : il est repris par
 * le journal JSON et envoyé à la base (en-tête `x-request-id`) pour corréler les lignes d'audit.
 * `organizationId` et `actorId` sont renseignés une fois l'authentification et le contexte tenant vérifiés.
 */
export type RequestContext = {
  requestId: string;
  organizationId?: string;
  actorId?: string;
};

const storage = new AsyncLocalStorage<RequestContext>();

/** Exécute `fn` (et tout ce qu'il attend) dans un contexte isolé ; la copie empêche une modification depuis l'extérieur. */
export function runWithRequestContext<R>(ctx: RequestContext, fn: () => R): R {
  return storage.run({ ...ctx }, fn);
}

/** Contexte courant, ou `undefined` hors requête (proxy, scripts, tests sans contexte). */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Complète le contexte courant (organisation, acteur) une fois connus. Sans effet hors contexte.
 * Une valeur absente ne remplace jamais une valeur déjà posée.
 */
export function updateRequestContext(patch: Partial<Pick<RequestContext, "organizationId" | "actorId">>): void {
  const current = storage.getStore();
  if (!current) return;
  if (patch.organizationId !== undefined) current.organizationId = patch.organizationId;
  if (patch.actorId !== undefined) current.actorId = patch.actorId;
}

/**
 * En-têtes à joindre à CHAQUE requête Supabase : `x-request-id` = identifiant serveur de la requête courante.
 * PostgREST l'expose à la base (`request.headers`), où les déclencheurs d'audit le recopient dans `audit_logs.request_id`.
 * Vide hors contexte de requête.
 */
export function requestIdHeaders(): Record<string, string> {
  const ctx = storage.getStore();
  return ctx ? { [REQUEST_ID_HEADER]: ctx.requestId } : {};
}
