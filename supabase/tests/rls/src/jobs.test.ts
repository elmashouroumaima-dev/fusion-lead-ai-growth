import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, apiAsUser, cleanupTestUsers, createTestUser, isDenied, psql, rowsOf } from "./harness";

/**
 * File de jobs par la Data API : fonctions réservées à service_role, claim exclusif sous VRAIE concurrence
 * (plusieurs requêtes simultanées), bail, retry, dead_letter, rejeu ; lecture owner/admin ; aucun accès direct.
 * Tests ré-exécutables : comptes, organisations et clés uniques par exécution ; les jobs créés sont supprimés.
 */

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
type Account = { id: string; email: string };
const createdUsers: string[] = [];
const key = (n: string | number) => `jt-${run}-${n}`;

async function newAccount(label: string): Promise<Account> {
  const account = await createTestUser(label);
  createdUsers.push(account.id);
  return account;
}
const svc = <T = unknown>(fn: string, args: Record<string, unknown>) => api<T>("service", "POST", `rpc/${fn}`, args);
const rpcAs = (user: Account, fn: string, args: Record<string, unknown>) => apiAsUser(user.id, "POST", `rpc/${fn}`, args);

type Claimed = { id: string; organization_id: string; attempts: number };
const claim = async (worker: string, limit = 1, lease = 60) => rowsOf<Claimed>(await svc<Claimed[]>("claim_jobs", { p_worker: worker, p_limit: limit, p_lease_seconds: lease }));
const enqueue = (org: string, k: string, extra: Record<string, unknown> = {}) =>
  svc<string>("enqueue_job", { p_org: org, p_kind: "noop", p_payload: {}, p_idempotency_key: k, ...extra });
const one = (sql: string): string => psql(sql).trim().split("\n").filter((l) => l.length > 0).pop() ?? "";

let owner: Account;
let sales: Account;
let other: Account;
let orgA: string;
let orgB: string;

beforeAll(async () => {
  [owner, sales, other] = await Promise.all([newAccount("jb-owner"), newAccount("jb-sales"), newAccount("jb-other")]);
  const a = await rpcAs(owner, "create_organization", { p_name: `JB A ${run}`, p_creation_key: `jb-a-${run}` });
  const b = await rpcAs(other, "create_organization", { p_name: `JB B ${run}`, p_creation_key: `jb-b-${run}` });
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  orgA = a.body as string;
  orgB = b.body as string;
  const { createHash, randomBytes } = await import("node:crypto");
  const hash = createHash("sha256").update(randomBytes(32).toString("base64url")).digest("hex");
  expect((await rpcAs(owner, "create_invitation", { p_org: orgA, p_email: sales.email, p_role: "sales_agent", p_token_hash: hash })).status).toBe(200);
  expect((await rpcAs(sales, "accept_invitation", { p_token_hash: hash })).status).toBe(200);
  // File vide au départ : seuls nos jobs sont réclamés par les tests.
  psql("delete from public.jobs where status in ('queued', 'running')");
});

afterAll(async () => {
  psql(`delete from public.jobs where organization_id in ('${orgA}', '${orgB}')`);
  await cleanupTestUsers(createdUsers);
});

describe("droits", () => {
  it("anon et authenticated ne peuvent appeler aucune fonction de la file", async () => {
    const args = { p_worker: "w-x", p_limit: 1, p_lease_seconds: 60 };
    expect(isDenied(await api("anon", "POST", "rpc/claim_jobs", args))).toBe(true);
    expect((await rpcAs(owner, "claim_jobs", args)).status).toBeGreaterThanOrEqual(400);
    expect((await rpcAs(owner, "enqueue_job", { p_org: orgA, p_kind: "noop", p_payload: {}, p_idempotency_key: key("authn") })).status).toBeGreaterThanOrEqual(400);
    expect((await rpcAs(owner, "replay_dead_letter", { p_org: orgA, p_job: "00000000-0000-4000-8000-000000000000" })).status).toBeGreaterThanOrEqual(400);
  });

  it("aucun accès direct à la table, même pour service_role ; owner ne peut qu'y lire", async () => {
    const row = { organization_id: orgA, kind: "noop", payload: {}, idempotency_key: key("direct") };
    expect(isDenied(await api("service", "POST", "jobs", row))).toBe(true);
    expect(isDenied(await api("service", "GET", "jobs?select=id"))).toBe(true);
    expect(isDenied(await apiAsUser(owner.id, "POST", "jobs", row))).toBe(true);
    expect(isDenied(await apiAsUser(owner.id, "PATCH", `jobs?organization_id=eq.${orgA}`, { status: "succeeded" }))).toBe(true);
    expect(isDenied(await apiAsUser(owner.id, "DELETE", `jobs?organization_id=eq.${orgA}`))).toBe(true);
    expect(isDenied(await api("anon", "GET", "jobs?select=id"))).toBe(true);
  });
});

describe("enqueue", () => {
  it("crée un job ; une clé dupliquée est refusée (23505) sans second job ; autre organisation : autorisée", async () => {
    expect((await enqueue(orgA, key("dup"))).status).toBe(200);
    const dup = await enqueue(orgA, key("dup"));
    expect(dup.status).toBeGreaterThanOrEqual(400);
    expect(dup.code).toBe("23505");
    expect((await enqueue(orgB, key("dup"))).status).toBe(200);
    expect(one(`select count(*) from public.jobs where idempotency_key = '${key("dup")}'`)).toBe("2");
  });

  it("refuse une charge utile avec secret ou corps de message, un type invalide, une organisation inconnue", async () => {
    const bad = [
      { p_payload: { token: "abc" } },
      { p_payload: { body: "x".repeat(300) } },
      { p_payload: [] },
      { p_kind: "Bad Kind" },
      { p_org: "00000000-0000-4000-8000-0000000000ee" },
    ];
    let i = 0;
    for (const extra of bad) {
      const r = await svc("enqueue_job", { p_org: orgA, p_kind: "noop", p_payload: {}, p_idempotency_key: key(`bad${i++}`), ...extra });
      expect(r.status, JSON.stringify(extra)).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("claim exclusif sous concurrence réelle", () => {
  it("8 workers simultanés, 60 jobs : chaque job est réclamé exactement une fois", async () => {
    const total = 60;
    // Les tests précédents laissent des jobs en attente : on repart d'une file vide pour compter exactement.
    psql("delete from public.jobs where status in ('queued', 'running')");
    for (let i = 0; i < total; i++) expect((await enqueue(orgA, key(`c${i}`))).status).toBe(200);

    const claimedBy = await Promise.all(
      Array.from({ length: 8 }, async (_, w) => {
        const mine: string[] = [];
        for (let round = 0; round < 40; round++) {
          const rows = await claim(`worker-${run}-${w}`, 3);
          if (rows.length === 0 && round > 2) break;
          mine.push(...rows.map((r) => r.id));
        }
        return mine;
      }),
    );
    const all = claimedBy.flat();
    expect(all).toHaveLength(total);
    expect(new Set(all).size).toBe(total);
    expect(one(`select count(*) from public.jobs where organization_id = '${orgA}' and idempotency_key like '${key("c")}%' and status = 'running' and attempts = 1`)).toBe(String(total));
    // Cette concurrence n'a produit qu'un seul détenteur par job.
    expect(one(`select count(*) from public.jobs where organization_id = '${orgA}' and idempotency_key like '${key("c")}%' and locked_by is null`)).toBe("0");
    for (const w of claimedBy) for (const id of w) await svc("complete_job", { p_job: id, p_worker: "inconnu" }); // refusés : pas le détenteur
    expect(one(`select count(*) from public.jobs where organization_id = '${orgA}' and idempotency_key like '${key("c")}%' and status = 'succeeded'`)).toBe("0");
  }, 120_000);
});

describe("cycle de vie : retry, bail, dead_letter, rejeu", () => {
  it("échec reprenable : remis en file avec backoff ; repris après le délai ; complete par le détenteur", async () => {
    const id = (await enqueue(orgA, key("life"))).body as string;
    const [job] = await claim(`w-life-${run}`);
    expect(job?.id).toBe(id);
    expect((await svc("fail_job", { p_job: id, p_worker: `w-life-${run}`, p_error: "timeout", p_retryable: true })).body).toBe("queued");
    expect(await claim(`w-life-${run}`)).toHaveLength(0); // backoff : pas encore dû
    psql(`update public.jobs set next_run_at = now() - interval '1 second' where id = '${id}'`);
    const [again] = await claim(`w-life-${run}`);
    expect(again?.id).toBe(id);
    expect(again?.attempts).toBe(2);
    expect((await svc("heartbeat_job", { p_job: id, p_worker: `w-life-${run}`, p_lease_seconds: 120 })).body).toBe(true);
    expect((await svc("complete_job", { p_job: id, p_worker: `w-other-${run}` })).body).toBe(false);
    expect((await svc("complete_job", { p_job: id, p_worker: `w-life-${run}` })).body).toBe(true);
  });

  it("bail expiré : le job est repris par un autre worker ; essais épuisés : dead_letter, rejeu audité", async () => {
    const id = (await enqueue(orgA, key("lease"), { p_max_attempts: 2 })).body as string;
    await claim(`w-dead-${run}`);
    psql(`update public.jobs set lease_until = now() - interval '1 minute' where id = '${id}'`);
    expect(await claim(`w-next-${run}`)).toHaveLength(0); // remis en file avec backoff
    expect(one(`select status from public.jobs where id = '${id}'`)).toBe("queued");
    psql(`update public.jobs set next_run_at = now() - interval '1 second' where id = '${id}'`);
    const [second] = await claim(`w-next-${run}`);
    expect(second?.attempts).toBe(2);
    psql(`update public.jobs set lease_until = now() - interval '1 minute' where id = '${id}'`);
    await claim(`w-next-${run}`);
    expect(one(`select status || ':' || last_error from public.jobs where id = '${id}'`)).toBe("dead_letter:lease_expired");
    expect(one(`select count(*) from public.audit_logs where action = 'job.dead_lettered' and entity_id = '${id}'`)).toBe("1");

    expect((await svc("replay_dead_letter", { p_org: orgB, p_job: id })).body).toBe(false); // autre organisation
    expect((await svc("replay_dead_letter", { p_org: orgA, p_job: id })).body).toBe(true);
    expect(one(`select count(*) from public.audit_logs where action = 'job.replayed' and entity_id = '${id}'`)).toBe("1");
    expect((await svc("cancel_job", { p_org: orgA, p_job: id })).body).toBe(true);
  });
});

describe("lecture (page Exploitation)", () => {
  it("l'owner lit les jobs de son organisation ; sales et l'autre organisation n'en voient aucun", async () => {
    await enqueue(orgA, key("read"));
    const ownerRows = rowsOf<{ organization_id: string }>(await apiAsUser(owner.id, "GET", `jobs?select=id,organization_id&idempotency_key=like.${key("read")}*`));
    expect(ownerRows).toHaveLength(1);
    expect(ownerRows[0]?.organization_id).toBe(orgA);
    expect(rowsOf(await apiAsUser(sales.id, "GET", `jobs?select=id&organization_id=eq.${orgA}`))).toHaveLength(0);
    expect(rowsOf(await apiAsUser(other.id, "GET", `jobs?select=id&organization_id=eq.${orgA}`))).toHaveLength(0);
  });
});
