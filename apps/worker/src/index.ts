import { EnvValidationError } from "@fusion-leap/domain";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { loadWorkerEnv } from "./env";
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
  const runner = new Runner({
    store: createSupabaseJobStore(env),
    registry: createDefaultRegistry(),
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
