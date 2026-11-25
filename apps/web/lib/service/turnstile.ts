import { randomUUID } from "node:crypto";

/**
 * Vérification d'un défi Cloudflare Turnstile côté SERVEUR (ADR 019, S-10). Le jeton du visiteur et son adresse sont envoyés à Cloudflare
 * (rien d'autre : ni e-mail, ni clé de formulaire, ni corps). La clé secrète vient de l'environnement serveur.
 *
 *  - `ok`          : Cloudflare confirme le défi ET le nom d'hôte du défi est celui de l'origine de la clé de formulaire ;
 *  - `failed`      : jeton refusé, expiré, déjà utilisé ou émis pour un autre site ;
 *  - `unavailable` : Cloudflare injoignable, trop lent ou réponse illisible (l'appelant décide : échec fermé si le défi est exigé).
 * Aucune cause n'est distinguée vers l'extérieur ; aucun jeton ni secret dans les erreurs.
 */
export type TurnstileOutcome = "ok" | "failed" | "unavailable";

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_TIMEOUT_MS = 3000;

export async function verifyTurnstile(input: {
  secret: string;
  token: string;
  ip: string | null;
  /** Origine (https) de la clé de formulaire : le défi doit avoir été émis pour son nom d'hôte. */
  origin: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<TurnstileOutcome> {
  let expectedHost: string;
  try {
    expectedHost = new URL(input.origin).hostname.toLowerCase();
  } catch {
    return "failed";
  }
  const body = new URLSearchParams({ secret: input.secret, response: input.token, idempotency_key: randomUUID() });
  if (input.ip !== null) body.set("remoteip", input.ip);
  let data: unknown;
  try {
    const response = await (input.fetchImpl ?? fetch)(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(input.timeoutMs ?? TURNSTILE_TIMEOUT_MS),
      cache: "no-store",
    });
    if (response.status >= 500) return "unavailable";
    data = await response.json();
  } catch {
    return "unavailable";
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return "unavailable";
  const { success, hostname } = data as Record<string, unknown>;
  if (typeof success !== "boolean") return "unavailable";
  if (!success) return "failed";
  return typeof hostname === "string" && hostname.length <= 255 && hostname.toLowerCase() === expectedHost ? "ok" : "failed";
}
