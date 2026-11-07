import { createBrowserClient } from "@supabase/ssr";
import { getClientEnv } from "../env/client";

/** Client navigateur : clé publishable uniquement (soumise à la RLS), jamais de secret. */
export function createClient() {
  const env = getClientEnv();
  return createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
}
