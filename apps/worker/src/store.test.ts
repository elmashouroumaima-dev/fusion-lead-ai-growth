import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc }) }));

import { createSupabaseJobStore, JobStoreError } from "./store";

const store = createSupabaseJobStore({ SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SECRET_KEY: "sb_secret_0123456789abcdefghij" });
const ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  organization_id: "22222222-2222-4222-8222-222222222222",
  kind: "noop",
  payload: { a: 1 },
  attempts: 1,
  max_attempts: 5,
  idempotency_key: "key-0001-abcd",
};

beforeEach(() => rpc.mockReset());

describe("createSupabaseJobStore", () => {
  it("claim : appelle claim_jobs et convertit les lignes", async () => {
    rpc.mockResolvedValue({ data: [ROW], error: null });
    const jobs = await store.claim("w1", 3, 60);
    expect(rpc).toHaveBeenCalledWith("claim_jobs", { p_worker: "w1", p_limit: 3, p_lease_seconds: 60 });
    expect(jobs).toEqual([
      { id: ROW.id, organizationId: ROW.organization_id, kind: "noop", payload: { a: 1 }, attempts: 1, maxAttempts: 5, idempotencyKey: ROW.idempotency_key },
    ]);
  });

  it("claim : aucune ligne => liste vide ; ligne mal formée ou erreur => JobStoreError sans fuite", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(store.claim("w1", 1, 60)).resolves.toEqual([]);
    rpc.mockResolvedValue({ data: [{ id: "x" }], error: null });
    await expect(store.claim("w1", 1, 60)).rejects.toBeInstanceOf(JobStoreError);
    rpc.mockResolvedValue({ data: null, error: { message: "password=secret host=db", code: "XX000" } });
    const error = await store.claim("w1", 1, 60).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(JobStoreError);
    expect((error as Error).message).toBe("job_store_claim_failed");
  });

  it("heartbeat / complete : true seulement si la base répond exactement true", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    await expect(store.heartbeat(ROW.id, "w1", 60)).resolves.toBe(true);
    await expect(store.complete(ROW.id, "w1")).resolves.toBe(true);
    rpc.mockResolvedValue({ data: "true", error: null });
    await expect(store.complete(ROW.id, "w1")).resolves.toBe(false);
    rpc.mockResolvedValue({ data: false, error: null });
    await expect(store.heartbeat(ROW.id, "w1", 60)).resolves.toBe(false);
  });

  it("fail : transmet code et retryable ; résultat borné à queued / dead_letter / null", async () => {
    rpc.mockResolvedValue({ data: "dead_letter", error: null });
    await expect(store.fail(ROW.id, "w1", "boom", false)).resolves.toBe("dead_letter");
    expect(rpc).toHaveBeenCalledWith("fail_job", { p_job: ROW.id, p_worker: "w1", p_error: "boom", p_retryable: false });
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(store.fail(ROW.id, "w1", "boom", true)).resolves.toBeNull();
    rpc.mockResolvedValue({ data: "autre", error: null });
    await expect(store.fail(ROW.id, "w1", "boom", true)).resolves.toBeNull();
    rpc.mockResolvedValue({ data: null, error: { code: "XX000" } });
    await expect(store.fail(ROW.id, "w1", "boom", true)).rejects.toBeInstanceOf(JobStoreError);
  });
});
