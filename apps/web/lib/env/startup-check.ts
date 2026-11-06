import { EnvValidationError } from "@fusion-leap/domain";
import { getClientEnv } from "./client";
import { getServerEnv } from "./server";

/**
 * Valide l'environnement au démarrage du serveur (J5). Next.js journalise une erreur levée dans
 * `instrumentation.ts` mais laisse le processus en vie (les requêtes échoueraient ensuite en 500) :
 * on arrête donc explicitement le processus avec un code non nul.
 * Module réservé au runtime Node.js (utilise `process.exit`).
 */
export function assertEnvOrExit(): void {
  try {
    getServerEnv();
    getClientEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(`\n[web] Démarrage refusé.\n${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}
