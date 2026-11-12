import type { Runner, WorkerLogger } from "./runner";

type SignalSource = { once(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown };

/**
 * Arrêt propre sur SIGTERM / SIGINT : le worker cesse de réclamer, attend les jobs en cours (délai borné), puis
 * termine. Code 0 si tout est fini, 1 si des jobs ont dû être abandonnés (leurs baux expireront). Un second signal
 * pendant l'arrêt est ignoré (l'arrêt est déjà en cours).
 */
export function installShutdown(options: {
  runner: Runner;
  logger: WorkerLogger;
  signals?: SignalSource;
  exit?: (code: number) => void;
}): void {
  const signals = options.signals ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let started = false;

  const handle = (signal: "SIGTERM" | "SIGINT") => () => {
    if (started) return;
    started = true;
    options.logger.info("shutdown_requested", { signal });
    options.runner
      .stop()
      .then((result) => exit(result.timedOut ? 1 : 0))
      .catch(() => exit(1));
  };

  signals.once("SIGTERM", handle("SIGTERM"));
  signals.once("SIGINT", handle("SIGINT"));
}
