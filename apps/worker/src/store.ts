import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

/** Job réclamé par ce worker (bail posé en base). `payload` n'est PAS encore validé (le handler le fait). */
export type ClaimedJob = {
  id: string;
  organizationId: string;
  kind: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  idempotencyKey: string;
};

export type FailOutcome = "queued" | "dead_letter" | null;

/**
 * Accès à la file de jobs. Une seule implémentation de production (RPC Supabase avec la clé service_role,
 * fonctions SQL réservées à ce rôle) ; les tests injectent une version en mémoire.
 */
export interface JobStore {
  claim(workerId: string, limit: number, leaseSeconds: number): Promise<ClaimedJob[]>;
  /** `false` si le bail n'appartient plus à ce worker (expiré et repris). */
  heartbeat(jobId: string, workerId: string, leaseSeconds: number): Promise<boolean>;
  complete(jobId: string, workerId: string): Promise<boolean>;
  fail(jobId: string, workerId: string, errorCode: string, retryable: boolean): Promise<FailOutcome>;
}

const claimedRow = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  kind: z.string(),
  payload: z.unknown(),
  attempts: z.number().int(),
  max_attempts: z.number().int(),
  idempotency_key: z.string(),
});

export type JobStoreEnv = { SUPABASE_URL: string; SUPABASE_SECRET_KEY: string };

export class JobStoreError extends Error {
  constructor(operation: string) {
    super(`job_store_${operation}_failed`);
    this.name = "JobStoreError";
  }
}

/** Store de production. Les erreurs de transport ne transportent ni URL, ni clé, ni message SQL. */
export function createSupabaseJobStore(env: JobStoreEnv): JobStore {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  return {
    async claim(workerId, limit, leaseSeconds) {
      const { data, error } = await client.rpc("claim_jobs", { p_worker: workerId, p_limit: limit, p_lease_seconds: leaseSeconds });
      if (error) throw new JobStoreError("claim");
      const rows = z.array(claimedRow).safeParse(data ?? []);
      if (!rows.success) throw new JobStoreError("claim");
      return rows.data.map((r) => ({
        id: r.id,
        organizationId: r.organization_id,
        kind: r.kind,
        payload: r.payload,
        attempts: r.attempts,
        maxAttempts: r.max_attempts,
        idempotencyKey: r.idempotency_key,
      }));
    },
    async heartbeat(jobId, workerId, leaseSeconds) {
      const { data, error } = await client.rpc("heartbeat_job", { p_job: jobId, p_worker: workerId, p_lease_seconds: leaseSeconds });
      if (error) throw new JobStoreError("heartbeat");
      return data === true;
    },
    async complete(jobId, workerId) {
      const { data, error } = await client.rpc("complete_job", { p_job: jobId, p_worker: workerId });
      if (error) throw new JobStoreError("complete");
      return data === true;
    },
    async fail(jobId, workerId, errorCode, retryable) {
      const { data, error } = await client.rpc("fail_job", { p_job: jobId, p_worker: workerId, p_error: errorCode, p_retryable: retryable });
      if (error) throw new JobStoreError("fail");
      return data === "queued" || data === "dead_letter" ? data : null;
    },
  };
}
