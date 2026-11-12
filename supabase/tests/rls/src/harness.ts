import { createHmac } from "node:crypto";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Harnais de tests RLS (J7, docs/testing/strategy.md §2–§4).
 *
 * Chaque appel passe par la vraie Data API (PostgREST) avec un JWT signé pour un utilisateur du
 * seed : on teste donc ensemble les GRANT, la RLS et les triggers, comme le ferait un client.
 * Le secret JWT est celui de la pile Supabase LOCALE (jamais un secret réel) ; les variables
 * d'environnement SUPABASE_API_URL / SUPABASE_PUBLISHABLE_KEY / SUPABASE_JWT_SECRET permettent de
 * le fournir en CI, sinon on le lit via `supabase status -o json`.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

interface LocalStack {
  apiUrl: string;
  publishableKey: string;
  jwtSecret: string;
}

function loadStack(): LocalStack {
  const { SUPABASE_API_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_JWT_SECRET } = process.env;
  if (SUPABASE_API_URL && SUPABASE_PUBLISHABLE_KEY && SUPABASE_JWT_SECRET) {
    return {
      apiUrl: SUPABASE_API_URL,
      publishableKey: SUPABASE_PUBLISHABLE_KEY,
      jwtSecret: SUPABASE_JWT_SECRET,
    };
  }
  const raw = execSync("pnpm exec supabase status -o json", {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
  });
  const status = JSON.parse(raw.slice(raw.indexOf("{"))) as Record<string, string>;
  const apiUrl = status.API_URL;
  const publishableKey = status.PUBLISHABLE_KEY;
  const jwtSecret = status.JWT_SECRET;
  if (!apiUrl || !publishableKey || !jwtSecret) {
    throw new Error(
      "Pile Supabase locale introuvable : lancer `pnpm db:start` puis `pnpm db:reset`.",
    );
  }
  return { apiUrl, publishableKey, jwtSecret };
}

const stack = loadStack();

const b64 = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");

/** JWT HS256 signé avec le secret LOCAL ; seul `sub` compte pour la RLS (le rôle vient de la base). */
function signJwt(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: "HS256", typ: "JWT" });
  const payload = b64({ aud: "authenticated", iat: now, exp: now + 600, ...claims });
  const signature = createHmac("sha256", stack.jwtSecret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

// --- Personas : identifiants identiques à supabase/seed.sql ---
export const ORG = {
  alpha: "a0000000-0000-4000-8000-0000000000a1",
  beta: "b0000000-0000-4000-8000-0000000000b1",
} as const;

export const USER = {
  shared: "00000000-0000-4000-8000-000000000001", // owner Alpha, sales_agent Beta
  alphaAdmin: "00000000-0000-4000-8000-000000000002",
  alphaMarketing: "00000000-0000-4000-8000-000000000003",
  alphaSales: "00000000-0000-4000-8000-000000000004",
  alphaAnalyst: "00000000-0000-4000-8000-000000000005",
  betaOwner: "00000000-0000-4000-8000-000000000006",
  betaAnalyst: "00000000-0000-4000-8000-000000000007",
  /** Utilisateur authentifié sans aucune adhésion. */
  nobody: "00000000-0000-4000-8000-0000000000ff",
} as const;

export type Persona = keyof typeof USER | "anon" | "service";

export interface ApiResult<T = unknown> {
  status: number;
  /** Corps JSON (tableau de lignes, ou objet d'erreur PostgREST avec `code`). */
  body: T;
  /** Code d'erreur Postgres/PostgREST si présent (ex. 42501 = droit ou RLS refusé). */
  code: string | undefined;
}

function headersFor(persona: Persona): Record<string, string> {
  const base: Record<string, string> = {
    apikey: stack.publishableKey,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  if (persona === "anon") return base;
  if (persona === "service") {
    return { ...base, Authorization: `Bearer ${signJwt({ role: "service_role" })}` };
  }
  return {
    ...base,
    Authorization: `Bearer ${signJwt({ sub: USER[persona], role: "authenticated" })}`,
  };
}

/**
 * Appel avec un JWT signé pour un utilisateur ARBITRAIRE (créé à la volée par `createTestUser`),
 * pour les tests qui ont besoin d'un vrai compte auth.users (ex. création d'organisation : FK).
 * `extraClaims` permet de simuler un JWT « forgé » (ex. user_metadata mensonger) ;
 * `extraHeaders` ajoute des en-têtes HTTP (ex. `x-request-id`, J12) sans pouvoir remplacer l'authentification.
 */
export async function apiAsUser<T = unknown>(
  userId: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  restPath: string,
  body?: unknown,
  extraClaims: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {
    apikey: stack.publishableKey,
    "Content-Type": "application/json",
    Prefer: "return=representation",
    ...extraHeaders,
    Authorization: `Bearer ${signJwt({ ...extraClaims, sub: userId, role: "authenticated" })}`,
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`${stack.apiUrl}/rest/v1/${restPath}`, init);
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as unknown) : [];
  const code =
    !Array.isArray(parsed) && parsed && typeof parsed === "object" && "code" in parsed
      ? String((parsed as { code: unknown }).code)
      : undefined;
  return { status: response.status, body: parsed as T, code };
}

/** Crée un compte réel via l'API admin GoTrue (service_role local). Adresse unique par appel. */
export async function createTestUser(
  label: string,
  options: { confirmed?: boolean } = {},
): Promise<{ id: string; email: string }> {
  const email = `rls-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@seed.test`;
  const response = await fetch(`${stack.apiUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: stack.publishableKey,
      "Content-Type": "application/json",
      Authorization: `Bearer ${signJwt({ role: "service_role" })}`,
    },
    // Valeur de test sans lien avec un vrai compte ; domaine réservé « .test ».
    body: JSON.stringify({ email, password: "FusionLeap-rls-2026!", email_confirm: options.confirmed ?? true }),
  });
  const json = (await response.json()) as { id?: string };
  if (response.status >= 300 || !json.id) {
    throw new Error(`création du compte de test impossible (${response.status})`);
  }
  return { id: json.id, email };
}

/**
 * Nettoyage BEST-EFFORT des organisations créées par des comptes de test, puis des comptes.
 * `protect_last_owner` interdit de supprimer le dernier owner même pour service_role : on passe donc
 * par `docker exec ... psql` avec session_replication_role = replica sur la pile LOCALE. Si Docker
 * n'est pas disponible (ex. CI sans accès au conteneur), le nettoyage est ignoré : les tests sont
 * conçus pour rester corrects sans lui (noms et clés uniques, assertions bornées aux ids créés) et
 * `pnpm db:reset` remet la base à zéro.
 * J12 : `audit_logs` est append-only (triggers ENABLE ALWAYS) et n'est donc JAMAIS purgé ici. Sous
 * Les triggers d'audit sont ENABLE ALWAYS : même sous session_replication_role = replica la suppression
 * des membres écrit des lignes `member.deleted` (acteur système). La clé étrangère RESTRICT, elle, n'est
 * pas vérifiée en mode replica : les entreprises de test sont supprimées et leurs lignes d'audit restent
 * orphelines (acceptable en local ; effacées par `pnpm db:reset`).
 */
export async function cleanupTestUsers(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const ids = userIds.filter((id) => /^[0-9a-f-]{36}$/.test(id));
  const list = ids.map((id) => `'${id}'`).join(",");
  const sql = [
    "set session_replication_role = replica;",
    `create temp table victims as select id from public.organizations where created_by in (${list});`,
    "delete from public.invitations where organization_id in (select id from victims);",
    "delete from public.idempotency_keys where organization_id in (select id from victims);",
    "delete from public.rate_limit_buckets where organization_id in (select id from victims);",
    "delete from public.subscriptions where organization_id in (select id from victims);",
    "delete from public.usage_counters where organization_id in (select id from victims);",
    "delete from public.organization_members where organization_id in (select id from victims);",
    "delete from public.organizations where id in (select id from victims);",
  ].join(" ");
  try {
    execSync("docker exec -i supabase_db_fusion-leap psql -U postgres -d postgres -v ON_ERROR_STOP=1", {
      input: sql,
      stdio: ["pipe", "ignore", "ignore"],
    });
  } catch {
    return; // best effort : Docker indisponible, on laisse les lignes (uniques par exécution)
  }
  for (const id of ids) {
    await fetch(`${stack.apiUrl}/auth/v1/admin/users/${id}`, {
      method: "DELETE",
      headers: {
        apikey: stack.publishableKey,
        Authorization: `Bearer ${signJwt({ role: "service_role" })}`,
      },
    });
  }
}

/**
 * Nettoyage BEST-EFFORT (J11) des clés d'idempotence créées par un test sur les entreprises du seed :
 * service_role n'a AUCUN droit sur public.idempotency_keys (par conception), donc passage par psql sur la
 * pile LOCALE. `prefix` doit être le préfixe unique de l'exécution ([A-Za-z0-9_-] seulement).
 */
export function purgeIdempotencyKeys(prefix: string): void {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(prefix)) return;
  try {
    execSync("docker exec -i supabase_db_fusion-leap psql -U postgres -d postgres -v ON_ERROR_STOP=1", {
      input: `delete from public.idempotency_keys where key like '${prefix}%';`,
      stdio: ["pipe", "ignore", "ignore"],
    });
  } catch {
    return; // Docker indisponible : les clés sont uniques par exécution et expirent après 24 h
  }
}

/** Appel REST `path` (ex. `organizations?select=id`) pour un persona ; ne lève jamais sur 4xx. */
export async function api<T = unknown>(
  persona: Persona,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  restPath: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const init: RequestInit = { method, headers: headersFor(persona) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`${stack.apiUrl}/rest/v1/${restPath}`, init);
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as unknown) : [];
  const code =
    !Array.isArray(parsed) && parsed && typeof parsed === "object" && "code" in parsed
      ? String((parsed as { code: unknown }).code)
      : undefined;
  return { status: response.status, body: parsed as T, code };
}

export const select = <T = Record<string, unknown>>(persona: Persona, restPath: string) =>
  api<T[]>(persona, "GET", restPath);

/** Lignes renvoyées (liste vide si refus). */
export function rowsOf<T>(result: ApiResult<T[] | unknown>): T[] {
  return Array.isArray(result.body) ? (result.body as T[]) : [];
}

/** Vrai si l'appel a été REFUSÉ par un privilège manquant ou une politique (HTTP 401/403, code 42501). */
export function isDenied(result: ApiResult): boolean {
  return result.status === 401 || result.status === 403;
}

export interface Snapshot {
  organizations: Record<string, unknown>[];
  members: Record<string, unknown>[];
}

/** Rétablit l'état du seed (via service_role) après un test qui modifie des lignes. */
export async function snapshotFixtures(): Promise<Snapshot> {
  const organizations = rowsOf<Record<string, unknown>>(
    await select("service", `organizations?select=*&id=in.(${ORG.alpha},${ORG.beta})&order=slug`),
  );
  const members = rowsOf<Record<string, unknown>>(
    await select("service", `organization_members?select=*&organization_id=in.(${ORG.alpha},${ORG.beta})&order=created_at,id`),
  );
  return { organizations, members };
}

export async function restoreFixtures(snapshot: Snapshot): Promise<void> {
  for (const org of snapshot.organizations) {
    await api("service", "PATCH", `organizations?id=eq.${String(org.id)}`, {
      name: org.name,
      timezone: org.timezone,
      locale: org.locale,
      settings: org.settings,
    });
  }
  const current = rowsOf<{ id: string }>(
    await select("service", `organization_members?select=id&organization_id=in.(${ORG.alpha},${ORG.beta})`),
  );
  const wanted = new Set(snapshot.members.map((m) => String(m.id)));
  // Réinsère d'abord les lignes supprimées, puis restaure rôle et statut des autres.
  const present = new Set(current.map((m) => m.id));
  const missing = snapshot.members.filter((m) => !present.has(String(m.id)));
  if (missing.length > 0) await api("service", "POST", "organization_members", missing);
  for (const member of snapshot.members) {
    await api("service", "PATCH", `organization_members?id=eq.${String(member.id)}`, {
      role: member.role,
      status: member.status,
    });
  }
  for (const row of current) {
    if (!wanted.has(row.id)) await api("service", "DELETE", `organization_members?id=eq.${row.id}`);
  }
  // Compteurs de fixture : un par entreprise, recréés à l'identique après chaque test.
  await api("service", "DELETE", "usage_counters?metric=like.rlstest_*");
  const created = await api("service", "POST", "usage_counters", [
    { organization_id: ORG.alpha, metric: "rlstest_a", period_start: "2026-11-01", value: 1 },
    { organization_id: ORG.beta, metric: "rlstest_b", period_start: "2026-11-01", value: 2 },
  ]);
  if (created.status !== 201)
    throw new Error(`restauration des compteurs impossible (${created.status})`);
}

/**
 * Exécute du SQL sur la pile LOCALE (psql dans le conteneur) et retourne la sortie (sans en-têtes).
 * Contrairement aux nettoyages best-effort, LÈVE en cas d'échec : à réserver aux tests qui ne peuvent pas
 * fonctionner sans (ex. simuler le temps qui passe en reculant created_at, que service_role ne peut pas écrire).
 */
export function psql(sql: string): string {
  return execSync("docker exec -i supabase_db_fusion-leap psql -U postgres -d postgres -v ON_ERROR_STOP=1 -tA", {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
