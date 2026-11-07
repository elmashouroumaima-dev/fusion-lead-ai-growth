import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getClientEnv } from "../env/client";
import { requestIdHeaders } from "../service/request-context";

/**
 * Client serveur (Server Components, Server Actions, Route Handlers) avec la clé publishable :
 * l'identité vient du cookie de session, la RLS s'applique.
 * `setAll` peut échouer dans un Server Component (cookies en lecture seule) : c'est sans danger
 * car le proxy est le seul endroit qui rafraîchit la session.
 */
export async function createClient() {
  const env = getClientEnv();
  const cookieStore = await cookies();
  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    // x-request-id (identifiant serveur) sur chaque requête : les lignes d'audit en base portent le même request_id.
    global: { headers: requestIdHeaders() },
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Dans un Server Component, cookies et en-têtes de réponse sont en lecture seule :
          // l'écriture est ignorée volontairement. Les en-têtes anti-cache (2e argument de
          // setAll) n'y sont pas posés non plus ; le proxy les applique, lui qui rafraîchit
          // la session et écrit les cookies sur la réponse.
        }
      },
    },
  });
}
