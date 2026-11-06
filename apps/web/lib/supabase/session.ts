import { createServerClient } from "@supabase/ssr";
import type { NextRequest, NextResponse } from "next/server";
import { getClientEnv } from "../env/client";

/**
 * Rafraîchit la session Supabase dans le proxy (seul endroit autorisé à le faire).
 * - `setAll` écrit sur la requête (pour les Server Components de CE rendu) ET sur la réponse
 *   donnée (pour le navigateur), avec les en-têtes anti-cache qui accompagnent les Set-Cookie.
 * - `getClaims()` valide le JWT : on ne se fie jamais à `getSession()` côté serveur.
 * Aucune donnée d'identité n'est journalisée.
 */
export async function updateSession(
  request: NextRequest,
  response: NextResponse,
): Promise<{ response: NextResponse; claims: unknown | null }> {
  const env = getClientEnv();
  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet, headers) => {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
          for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
        },
      },
    },
  );

  // Aucun code entre createServerClient et getClaims (risque de déconnexions aléatoires).
  const { data, error } = await supabase.auth.getClaims();
  return { response, claims: error ? null : (data?.claims ?? null) };
}

/** Recopie cookies de session et en-têtes anti-cache sur une réponse de redirection. */
export function copySessionState(from: NextResponse, to: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) to.cookies.set(cookie);
  for (const name of ["cache-control", "expires", "pragma"]) {
    const value = from.headers.get(name);
    if (value !== null) to.headers.set(name, value);
  }
  return to;
}
