import { createPostmarkProvider } from "@fusion-leap/adapters";
import { EnvValidationError } from "@fusion-leap/domain";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { createSupabaseLeadAssigner } from "./assignment";
import { loadWorkerEnv } from "./env";
import { createSupabaseCrmSyncGateway } from "./crm-sync";
import { createSupabaseImportGateway } from "./imports";
import { createSupabaseSecretReader, createSupabaseSendGateway } from "./send";
import { createEmailWebhookProcessor, createSupabaseEmailEventGateway } from "./email-webhook";
import { createSupabaseWebhookGateway, type WebhookProcessors } from "./webhooks";
import { createDefaultRegistry } from "./handlers";
import { WORKER_NAME } from "./info";
import { Runner, type WorkerLogger } from "./runner";
import { installShutdown } from "./shutdown";
import { createSupabaseJobStore } from "./store";


/** Journal JSON sur stdout : un événement par ligne, champs scalaires seulement. */
const logger: WorkerLogger = {
  info: (event, fields) => console.info(JSON.stringify({ level: "info", worker: WORKER_NAME, event, ...fields })),
  warn: (event, fields) => console.warn(JSON.stringify({ level: "warn", worker: WORKER_NAME, event, ...fields })),
  error: (event, fields) => console.error(JSON.stringify({ level: "error", worker: WORKER_NAME, event, ...fields })),
};

try {
  const env = loadWorkerEnv();
  const workerId = `${hostname().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60)}:${process.pid}:${randomBytes(4).toString("hex")}`;
  // processeurs de webhooks par fournisseur : e-mail (J32) ; WhatsApp s'enregistre au J35. Sans processeur, un événement est marqué `failed` (`no_processor`), re-jouable.
  const webhookProcessors: WebhookProcessors = new Map([["email", createEmailWebhookProcessor(createSupabaseEmailEventGateway(env))]]);
  const runner = new Runner({
    store: createSupabaseJobStore(env),
    registry: createDefaultRegistry({ assigner: createSupabaseLeadAssigner(env), imports: createSupabaseImportGateway(env), crm: createSupabaseCrmSyncGateway(env), send: { gateway: createSupabaseSendGateway(env), readSecret: createSupabaseSecretReader(env), provider: createPostmarkProvider() }, webhooks: { gateway: createSupabaseWebhookGateway(env), processors: webhookProcessors } }),
    workerId,
    logger,
  });
  installShutdown({ runner, logger });
  runner.start();
} catch (error) {
  if (error instanceof EnvValidationError) {
    console.error(`[${WORKER_NAME}] démarrage refusé.\n${error.message}`);
    process.exit(1);
  }
  throw error;
}
