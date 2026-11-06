import { parseClientEnv, type ClientEnv } from "@fusion-leap/domain";

/**
 * Environnement public (navigateur). Next.js n'injecte les variables `NEXT_PUBLIC_*` qu'à la
 * condition qu'elles soient lues littéralement (`process.env.NEXT_PUBLIC_X`) : on ne passe donc
 * jamais `process.env` en bloc ici, et aucune variable serveur n'est accessible depuis ce module.
 */
export function getClientEnv(): ClientEnv {
  return parseClientEnv({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
}
