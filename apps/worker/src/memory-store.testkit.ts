import type { ClaimedJob, FailOutcome, JobStore } from "./store";

export type MemJob = ClaimedJob & {
  status: "queued" | "running" | "succeeded" | "dead_letter";
  lockedBy: string | null;
  lastError: string | null;
  retryable?: boolean;
};

/**
 * Store en mémoire qui reproduit la sémantique des fonctions SQL (un job n'a qu'un seul détenteur, seul le
 * détenteur peut clore, essais épuisés ou erreur définitive = dead_letter). Sert aux tests du runner.
 */
export class MemoryStore implements JobStore {
  readonly jobs = new Map<string, MemJob>();
  readonly calls = { claim: 0, heartbeat: 0, complete: 0, fail: 0 };
  failClaim = 0;
  heartbeatResult = true;

  add(partial: Partial<MemJob> & { id: string }): MemJob {
    const job: MemJob = {
      organizationId: "11111111-1111-4111-8111-111111111111",
      kind: "noop",
      payload: {},
      attempts: 0,
      maxAttempts: 3,
      idempotencyKey: `key-${partial.id}`,
      status: "queued",
      lockedBy: null,
      lastError: null,
      ...partial,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  async claim(workerId: string, limit: number): Promise<ClaimedJob[]> {
    this.calls.claim += 1;
    if (this.failClaim > 0) {
      this.failClaim -= 1;
      throw new Error("db down");
    }
    const picked: MemJob[] = [];
    for (const job of this.jobs.values()) {
      if (picked.length >= limit) break;
      if (job.status !== "queued") continue;
      job.status = "running";
      job.lockedBy = workerId;
      job.attempts += 1;
      picked.push(job);
    }
    return picked.map((j) => ({
      id: j.id,
      organizationId: j.organizationId,
      kind: j.kind,
      payload: j.payload,
      attempts: j.attempts,
      maxAttempts: j.maxAttempts,
      idempotencyKey: j.idempotencyKey,
    }));
  }

  async heartbeat(jobId: string, workerId: string): Promise<boolean> {
    this.calls.heartbeat += 1;
    const job = this.jobs.get(jobId);
    return this.heartbeatResult && job?.status === "running" && job.lockedBy === workerId;
  }

  async complete(jobId: string, workerId: string): Promise<boolean> {
    this.calls.complete += 1;
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "running" || job.lockedBy !== workerId) return false;
    job.status = "succeeded";
    job.lockedBy = null;
    return true;
  }

  async fail(jobId: string, workerId: string, errorCode: string, retryable: boolean): Promise<FailOutcome> {
    this.calls.fail += 1;
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "running" || job.lockedBy !== workerId) return null;
    job.lastError = errorCode;
    job.retryable = retryable;
    job.lockedBy = null;
    if (!retryable || job.attempts >= job.maxAttempts) {
      job.status = "dead_letter";
      return "dead_letter";
    }
    job.status = "queued";
    return "queued";
  }
}
