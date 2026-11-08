import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Client HTTP des scénarios d'acceptation : se connecte comme un navigateur (mot de passe du seed LOCAL,
 * lu dans supabase/seed.sql, jamais dupliqué), pose le cookie de session au format de @supabase/ssr
 * et appelle les pages de l'application en suivant NI les redirections NI les cookies d'un autre contexte.
 * Prérequis : pile Supabase locale ET application démarrée (`pnpm dev`, ou E2E_BASE_URL).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SUPABASE_URL = process.env.SUPABASE_API_URL ?? "http://127.0.0.1:54321";
export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

const seedPassword = (): string => {
  const sql = readFileSync(path.join(root, "supabase/seed.sql"), "utf8");
  const match = /dev_password constant text := '([^']+)'/.exec(sql);
  if (!match?.[1]) throw new Error("mot de passe de développement introuvable dans supabase/seed.sql");
  return match[1];
};

/** Clé publique de la pile locale (publishable) : lue via la CLI comme le harnais RLS. */
export async function publishableKey(): Promise<string> {
  const fromEnv = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (fromEnv) return fromEnv;
  const { execSync } = await import("node:child_process");
  const raw = execSync("pnpm exec supabase status -o json", {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
  });
  const status = JSON.parse(raw.slice(raw.indexOf("{"))) as Record<string, string>;
  if (!status.PUBLISHABLE_KEY) throw new Error("pile Supabase locale introuvable");
  return status.PUBLISHABLE_KEY;
}

/** Nom du cookie de session de @supabase/ssr : `sb-<premier label du nom d'hôte>-auth-token`. */
const sessionCookieName = (): string => `sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token`;
const CHUNK = 3180;

export type Session = { cookies: Record<string, string> };

export async function signIn(email: string): Promise<Session> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: await publishableKey(), "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: seedPassword() }),
  });
  if (!response.ok) throw new Error(`connexion impossible pour un compte du seed (${response.status}) : \`pnpm db:reset\` ?`);
  const value = `base64-${Buffer.from(await response.text()).toString("base64url")}`;
  const name = sessionCookieName();
  const cookies: Record<string, string> = {};
  if (value.length <= CHUNK) cookies[name] = value;
  else for (let i = 0; i * CHUNK < value.length; i++) cookies[`${name}.${i}`] = value.slice(i * CHUNK, (i + 1) * CHUNK);
  return { cookies };
}

export type Page = { status: number; location: string | null; body: string };

/** GET d'une page ; `activeOrg` pose le cookie d'organisation active (un INDICE côté serveur). */
export async function getPage(session: Session | null, pathname: string, activeOrg?: string): Promise<Page> {
  const jar = { ...(session?.cookies ?? {}), ...(activeOrg ? { fl_active_org: activeOrg } : {}) };
  const response = await fetch(`${BASE_URL}${pathname}`, {
    redirect: "manual",
    headers: { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ") },
  });
  return { status: response.status, location: response.headers.get("location"), body: await response.text() };
}

export type ApiResponse = { status: number; headers: Headers; json: Record<string, unknown> };

/** POST JSON vers une route d'API (`activeOrg` : indice d'entreprise active, cookie ; `headers` : en-têtes ajoutés). */
export async function postJson(
  session: Session | null,
  pathname: string,
  body: unknown,
  options: { activeOrg?: string; headers?: Record<string, string> } = {},
): Promise<ApiResponse> {
  const jar = { ...(session?.cookies ?? {}), ...(options.activeOrg ? { fl_active_org: options.activeOrg } : {}) };
  const response = await fetch(`${BASE_URL}${pathname}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "), ...options.headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: response.status, headers: response.headers, json };
}

/** Texte visible d'une page (scripts, styles et balises retirés) : sert aux assertions « aucune donnée de l'autre entreprise ». */
export const visibleText = (page: Page): string =>
  page.body
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

/** Chemin (sans hôte) d'une redirection, ou null. */
export const redirectPath = (page: Page): string | null =>
  page.location ? new URL(page.location, BASE_URL).pathname : null;
