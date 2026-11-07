import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("../supabase/admin", () => ({ createAdminClient: () => ({ rpc }) }));

import { LIMITS, takeToken, USER_SCOPE_PROVIDER } from "./rate-limit";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockReset(); // vide aussi les files de valeurs « une fois » laissées par un test précédent
  rpc.mockResolvedValue({ data: { allowed: true, remaining: 29, retry_after_seconds: 0 }, error: null });
});

describe("LIMITS (décision du responsable technique)", () => {
  it("mutation : 30 et 0,5/s ; sensible : 10 et 1/6 par seconde", () => {
    expect(LIMITS.mutation).toEqual({ capacity: 30, refillPerSecond: 0.5 });
    expect(LIMITS.sensitive.capacity).toBe(10);
    expect(LIMITS.sensitive.refillPerSecond).toBeCloseTo(1 / 6, 10);
  });
});

describe("takeToken", () => {
  it("appelle rate_limit_take avec le contrat : organisation, seau opaque scope:uuid, coût 1", async () => {
    await expect(takeToken({ organizationId: ORG, userId: USER, scope: "mutation" })).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(rpc).toHaveBeenNthCalledWith(1, "rate_limit_take", {
      p_org: ORG,
      p_provider: null,
      p_bucket_key: `mutation:${USER}`,
      p_capacity: 30,
      p_refill_per_second: 0.5,
      p_cost: 1,
    });
  });

  it("DEUX jetons avec une organisation : (organisation, utilisateur) puis seau global de l'utilisateur (même capacité et recharge)", async () => {
    await takeToken({ organizationId: ORG, userId: USER, scope: "sensitive" });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_org: ORG, p_provider: null, p_bucket_key: `sensitive:${USER}`, p_capacity: 10 });
    expect(rpc.mock.calls[1]?.[1]).toEqual({
      p_org: null,
      p_provider: USER_SCOPE_PROVIDER,
      p_bucket_key: `sensitive:${USER}`,
      p_capacity: 10,
      p_refill_per_second: 1 / 6,
      p_cost: 1,
    });
  });

  it("un utilisateur dans deux organisations partage le MÊME seau global (le quota ne se multiplie pas)", async () => {
    const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await takeToken({ organizationId: ORG, userId: USER, scope: "mutation" });
    await takeToken({ organizationId: OTHER, userId: USER, scope: "mutation" });
    const globals = rpc.mock.calls.map((c) => c[1] as { p_org: string | null; p_provider: string | null; p_bucket_key: string }).filter((a) => a.p_org === null);
    expect(globals).toHaveLength(2);
    expect(new Set(globals.map((a) => `${a.p_provider}|${a.p_bucket_key}`)).size).toBe(1);
  });

  it("sans organisation : UN seul jeton (le seau (null, utilisateur) est déjà le seau global)", async () => {
    await takeToken({ organizationId: null, userId: USER, scope: "sensitive" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("le seau d'organisation refuse : refus, avec le Retry-After du seau le plus long (les deux sont interrogés)", async () => {
    rpc.mockResolvedValueOnce({ data: { allowed: false, remaining: 0, retry_after_seconds: 3 }, error: null });
    rpc.mockResolvedValueOnce({ data: { allowed: false, remaining: 0, retry_after_seconds: 40.2 }, error: null });
    await expect(takeToken({ organizationId: ORG, userId: USER, scope: "sensitive" })).resolves.toEqual({ allowed: false, retryAfterSeconds: 41 });
    rpc.mockResolvedValueOnce({ data: { allowed: false, remaining: 0, retry_after_seconds: 12 }, error: null });
    rpc.mockResolvedValueOnce({ data: { allowed: false, remaining: 0, retry_after_seconds: 2 }, error: null });
    await expect(takeToken({ organizationId: ORG, userId: USER, scope: "sensitive" })).resolves.toEqual({ allowed: false, retryAfterSeconds: 12 });
  });

  it("seul le seau global refuse : refus avec son Retry-After", async () => {
    rpc.mockResolvedValueOnce({ data: { allowed: true, remaining: 5, retry_after_seconds: 0 }, error: null });
    rpc.mockResolvedValueOnce({ data: { allowed: false, remaining: 0, retry_after_seconds: 7 }, error: null });
    await expect(takeToken({ organizationId: ORG, userId: USER, scope: "sensitive" })).resolves.toEqual({ allowed: false, retryAfterSeconds: 7 });
  });

  it("seul le seau d'organisation refuse : refus avec son Retry-After", async () => {
    rpc.mockResolvedValueOnce({ data: { allowed: false, remaining: 0, retry_after_seconds: 9 }, error: null });
    rpc.mockResolvedValueOnce({ data: { allowed: true, remaining: 5, retry_after_seconds: 0 }, error: null });
    await expect(takeToken({ organizationId: ORG, userId: USER, scope: "sensitive" })).resolves.toEqual({ allowed: false, retryAfterSeconds: 9 });
  });

  it.each([
    ["le seau d'organisation", 0],
    ["le seau global", 1],
  ])("panne de %s : ÉCHEC FERMÉ service_unavailable", async (_l, failing) => {
    const ok = { data: { allowed: true, remaining: 5, retry_after_seconds: 0 }, error: null };
    for (let i = 0; i < 2; i += 1) {
      if (i === failing) rpc.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      else rpc.mockResolvedValueOnce(ok);
    }
    await expect(takeToken({ organizationId: ORG, userId: USER, scope: "sensitive" })).rejects.toMatchObject({ code: "service_unavailable", status: 503 });
  });

  it.each([
    ["le seau d'organisation", 0],
    ["le seau global", 1],
  ])("réponse mal formée de %s : ÉCHEC FERMÉ", async (_l, bad) => {
    const ok = { data: { allowed: true, remaining: 5, retry_after_seconds: 0 }, error: null };
    for (let i = 0; i < 2; i += 1) rpc.mockResolvedValueOnce(i === bad ? { data: { allowed: "yes" }, error: null } : ok);
    await expect(takeToken({ organizationId: ORG, userId: USER, scope: "sensitive" })).rejects.toMatchObject({ code: "service_unavailable" });
  });

  it("sans organisation : portée par utilisateur en provider (contrat SQL : organisation OU provider)", async () => {
    await takeToken({ organizationId: null, userId: USER, scope: "sensitive" });
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_org: null, p_provider: USER_SCOPE_PROVIDER, p_bucket_key: `sensitive:${USER}` });
  });

  it("la clé du seau respecte ^[A-Za-z0-9:_.-]+$ et ne contient aucun e-mail", async () => {
    await takeToken({ organizationId: ORG, userId: USER, scope: "sensitive" });
    const key = (rpc.mock.calls[0]?.[1] as { p_bucket_key: string }).p_bucket_key;
    expect(key).toMatch(/^[A-Za-z0-9:_.-]{1,200}$/);
    expect(key).not.toContain("@");
  });

  it("refus : retry_after_seconds arrondi à l'entier supérieur, au moins 1", async () => {
    rpc.mockResolvedValueOnce({ data: { allowed: false, remaining: 0, retry_after_seconds: 5.2 }, error: null });
    await expect(takeToken({ organizationId: ORG, userId: USER, scope: "sensitive" })).resolves.toEqual({ allowed: false, retryAfterSeconds: 6 });
    rpc.mockResolvedValueOnce({ data: { allowed: false, remaining: 0, retry_after_seconds: 0 }, error: null });
    await expect(takeToken({ organizationId: ORG, userId: USER, scope: "sensitive" })).resolves.toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it.each([
    ["erreur SQL", { data: null, error: { code: "XX000", message: "secret" } }],
    ["réponse nulle", { data: null, error: null }],
    ["réponse mal formée", { data: { allowed: "yes" }, error: null }],
    ["tableau", { data: [], error: null }],
  ])("échec fermé : %s -> service_unavailable", async (_l, result) => {
    rpc.mockResolvedValueOnce(result);
    await expect(takeToken({ organizationId: ORG, userId: USER, scope: "mutation" })).rejects.toMatchObject({ code: "service_unavailable", status: 503 });
  });

  it("échec fermé : exception réseau", async () => {
    rpc.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(takeToken({ organizationId: ORG, userId: USER, scope: "mutation" })).rejects.toMatchObject({ code: "service_unavailable" });
  });
});
