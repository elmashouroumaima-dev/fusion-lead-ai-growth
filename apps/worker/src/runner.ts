import { errorCode, NonRetryableError } from "./errors";
import type { HandlerRegistry } from "./handlers";
import type { ClaimedJob, JobStore } from "./store";

/** Journal du worker : des champs scalaires uniquement (jamais de charge utile, de jeton ni de message). */
export type WorkerLogger = {
  info(event: string, fields?: Record<string, string | number | boolean>): void;
  warn(event: string, fields?: Record<string, string | number | boolean>): void;
  error(event: string, fields?: Record<string, string | number | boolean>): void;
};

export const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };

export type RunnerOptions = {
  store: JobStore;
  registry: HandlerRegistry;
  /** Identifiant de ce worker (alphabet `[A-Za-z0-9._:-]`, 128 caractères au plus). */
  workerId: string;
  /** Jobs exécutés en parallèle par ce worker. */
  concurrency?: number;
  leaseSeconds?: number;
  /** Intervalle du heartbeat (ms) ; défaut : un tiers du bail. */
  heartbeatMs?: number;
  /** Pause quand la file est vide ou en cas d'erreur de la base (ms). */
  pollMs?: number;
  /** Délai accordé aux jobs en cours à l'arrêt (ms) avant l'abandon (leurs baux expireront). */
  shutdownTimeoutMs?: number;
  /** Durée maximale d'un handler (ms) : au-delà, le signal est déclenché et le job échoue (code HandlerTimeout). */
  handlerTimeoutMs?: number;
  logger?: WorkerLogger;
};

export type StopResult = { timedOut: boolean; abandoned: number };

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Boucle du worker : réclame des jobs (bail), les exécute avec heartbeat, puis les clôt (succès, nouvel essai
 * avec backoff ou dead_letter, décidés par la base). Arrêt propre : plus aucun nouveau job, attente des jobs en
 * cours (limitée), puis abandon (bail expiré = reprise par un autre worker).
 */
export class Runner {
  private readonly store: JobStore;
  private readonly registry: HandlerRegistry;
  private readonly workerId: string;
  private readonly concurrency: number;
  private readonly leaseSeconds: number;
  private readonly heartbeatMs: number;
  private readonly pollMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly handlerTimeoutMs: number;
  private readonly log: WorkerLogger;

  private readonly inFlight = new Map<string, { done: Promise<void>; abort: AbortController }>();
  private stopping = false;
  private loop: Promise<void> | null = null;
  private readonly wake = new AbortController();

  constructor(options: RunnerOptions) {
    this.store = options.store;
    this.registry = options.registry;
    this.workerId = options.workerId;
    this.concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 50));
    this.leaseSeconds = Math.max(5, Math.min(options.leaseSeconds ?? 60, 3600));
    this.heartbeatMs = options.heartbeatMs ?? Math.floor((this.leaseSeconds * 1000) / 3);
    this.pollMs = options.pollMs ?? 1000;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 30_000;
    this.handlerTimeoutMs = options.handlerTimeoutMs ?? 15 * 60_000;
    this.log = options.logger ?? silentLogger;
  }

  get activeJobs(): number {
    return this.inFlight.size;
  }

  /** Réclame jusqu'à la capacité libre et démarre l'exécution (sans l'attendre). Renvoie le nombre de jobs pris. */
  async tick(): Promise<number> {
    if (this.stopping) return 0;
    const free = this.concurrency - this.inFlight.size;
    if (free <= 0) return 0;
    const jobs = await this.store.claim(this.workerId, free, this.leaseSeconds);
    for (const job of jobs) this.launch(job);
    return jobs.length;
  }

  /** Attend que tous les jobs lancés soient terminés (tests). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight.values()].map((j) => j.done));
  }

  start(): void {
    if (this.loop) return;
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    this.log.info("worker_started", { worker_id: this.workerId, concurrency: this.concurrency });
    while (!this.stopping) {
      let claimed = 0;
      try {
        claimed = await this.tick();
      } catch (error) {
        // Base injoignable ou refus : on journalise le code seulement et on réessaie après la pause.
        this.log.error("claim_failed", { code: errorCode(error) });
      }
      const saturated = this.inFlight.size >= this.concurrency;
      if (claimed === 0 || saturated) await sleep(this.pollMs, this.wake.signal);
    }
  }

  /** Arrêt propre (SIGTERM). Idempotent. */
  async stop(): Promise<StopResult> {
    this.stopping = true;
    this.wake.abort();
    await this.loop;
    if (this.inFlight.size === 0) {
      this.log.info("worker_stopped", { abandoned: 0 });
      return { timedOut: false, abandoned: 0 };
    }

    this.log.info("worker_draining", { active: this.inFlight.size });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.shutdownTimeoutMs);
    });
    const outcome = await Promise.race([this.idle().then(() => "idle" as const), timeout]);
    if (timer) clearTimeout(timer);

    if (outcome === "timeout") {
      const abandoned = this.inFlight.size;
      for (const { abort } of this.inFlight.values()) abort.abort();
      this.log.warn("worker_stopped_with_abandoned_jobs", { abandoned });
      return { timedOut: true, abandoned };
    }
    this.log.info("worker_stopped", { abandoned: 0 });
    return { timedOut: false, abandoned: 0 };
  }

  private launch(job: ClaimedJob): void {
    const abort = new AbortController();
    const done = this.execute(job, abort).finally(() => this.inFlight.delete(job.id));
    this.inFlight.set(job.id, { done, abort });
  }

  private async execute(job: ClaimedJob, abort: AbortController): Promise<void> {
    const fields = { job: job.id, org: job.organizationId, kind: job.kind, attempt: job.attempts };
    let leaseLost = false;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const heartbeat = setInterval(() => {
      this.store
        .heartbeat(job.id, this.workerId, this.leaseSeconds)
        .then((ok) => {
          if (!ok && !leaseLost) {
            leaseLost = true;
            this.log.warn("lease_lost", fields);
            abort.abort();
          }
        })
        .catch((error: unknown) => this.log.warn("heartbeat_failed", { ...fields, code: errorCode(error) }));
    }, this.heartbeatMs);

    try {
      const handler = this.registry.get(job.kind);
      if (!handler) throw new NonRetryableError("unknown_kind");
      const parsed = handler.parse(job.payload);
      if (!parsed.success) throw new NonRetryableError("invalid_payload");

      // Délai maximal : un handler qui ignore le signal ne garde pas indéfiniment son bail (heartbeat) ni son emplacement.
      const timeout = new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(() => {
          abort.abort();
          const error = new Error("handler_timeout");
          error.name = "HandlerTimeout";
          reject(error);
        }, this.handlerTimeoutMs);
      });
      await Promise.race([
        handler.run(
          {
            jobId: job.id,
            organizationId: job.organizationId,
            idempotencyKey: job.idempotencyKey,
            attempt: job.attempts,
            maxAttempts: job.maxAttempts,
            signal: abort.signal,
          },
          parsed.data,
        ),
        timeout,
      ]);
      clearTimeout(timeoutTimer);

      if (leaseLost) return; // Un autre worker a repris le job : ne rien écrire.
      if (abort.signal.aborted) {
        // Arrêt forcé : le handler a pu s'interrompre à mi-chemin ; on ne déclare pas de succès, le bail expirera.
        this.log.warn("job_abandoned", fields);
        return;
      }
      try {
        const completed = await this.store.complete(job.id, this.workerId);
        this.log[completed ? "info" : "warn"](completed ? "job_succeeded" : "job_complete_refused", fields);
      } catch (storeError) {
        // Succès non enregistré : ne PAS déclarer d'échec (le handler a réussi). Le bail expirera et le job sera
        // repris : exécution « au moins une fois », d'où l'idempotency_key obligatoire dans chaque handler.
        this.log.error("job_complete_unrecorded", { ...fields, code: errorCode(storeError) });
      }
    } catch (error) {
      if (leaseLost) return;
      // Arrêt forcé du worker : on n'enregistre pas d'échec (aucune tentative consommée), le bail expirera.
      if (abort.signal.aborted && this.stopping && errorCode(error) !== "HandlerTimeout") {
        this.log.warn("job_abandoned", fields);
        return;
      }
      const code = errorCode(error);
      const retryable = !(error instanceof NonRetryableError);
      try {
        const outcome = await this.store.fail(job.id, this.workerId, code, retryable);
        this.log.warn("job_failed", { ...fields, code, retryable, outcome: outcome ?? "not_owner" });
      } catch (storeError) {
        // Impossible d'enregistrer l'échec : le bail expirera et la base reprendra le job.
        this.log.error("job_fail_unrecorded", { ...fields, code: errorCode(storeError) });
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeoutTimer);
    }
  }
}
