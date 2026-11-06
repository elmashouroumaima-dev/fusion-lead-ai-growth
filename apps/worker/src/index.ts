import { EnvValidationError } from "@fusion-leap/domain";
import { loadWorkerEnv } from "./env";
import { WORKER_NAME } from "./info";

// Squelette J4/J5 : la boucle de claim des jobs arrive au J13 (ADR 003). Aucune logique métier ici.
try {
  const env = loadWorkerEnv();
  console.info(
    `[${WORKER_NAME}] environnement ${env.APP_ENV} valide ; aucun job traité avant J13.`,
  );
} catch (error) {
  if (error instanceof EnvValidationError) {
    console.error(`[${WORKER_NAME}] démarrage refusé.\n${error.message}`);
    process.exit(1);
  }
  throw error;
}
