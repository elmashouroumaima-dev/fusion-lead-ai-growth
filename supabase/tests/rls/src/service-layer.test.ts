import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { api, isDenied, ORG, psql, purgeIdempotencyKeys, type Persona } from "./harness";

/**
 * Couche service (J11) par la Data API : idempotence (idempotency_*) et seau à jetons (rate_limit_take).
 * Les appels passent par POST /rest/v1/rpc/<nom> avec un JWT signé par persona du seed. Les clés et seaux
 * portent un préfixe UNIQUE par exécution : tests ré-exécutables, aucun état partagé entre exécutions.
 */

const run = `rls${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const hashOf = (value: string) => createHash("sha256").update(value).digest("hex");

const begin = (persona: Persona, org: string, key: string, hash: string) =>
  api<Record<string, unknown>>(persona, "POST", "rpc/idempotency_begin", {
    p_org: org,
    p_key: key,
    p_request_hash: hash,
  });
const complete = (
  persona: Persona,
  org: string,
  key: string,
  attempt: string | null,
  status: number,
  response: unknown,
) =>
  api<Record<string, unknown>>(persona, "POST", "rpc/idempotency_complete", {
    p_org: org,
    p_key: key,
    p_attempt_id: attempt,
    p_status_code: status,
    p_response: response,
  });
const abandon = (persona: Persona, org: string, key: string, attempt: string | null) =>
  api(persona, "POST", "rpc/idempotency_abandon", { p_org: org, p_key: key, p_attempt_id: attempt });
/** begin attendu `new` : retourne l'attempt_id (uuid) de l'essai. */
const open = async (persona: Persona, org: string, key: string, hash: string): Promise<string> => {
  const result = await begin(persona, org, key, hash);
  expect(result.status).toBe(200);
  expect(result.body.state).toBe("new");
  expect(result.body.attempt_id).toMatch(/^[0-9a-f-]{36}$/);
  return result.body.attempt_id as string;
};
const randomUuid = () => "00000000-0000-4000-8000-" + Math.random().toString(16).slice(2, 14).padEnd(12, "0");
const take = (
  persona: Persona,
  args: { org?: string | null; provider?: string | null; key: string; capacity: number; refill: number; cost?: number },
) =>
  api<{ allowed: boolean; remaining: number; retry_after_seconds: number }>(persona, "POST", "rpc/rate_limit_take", {
    p_org: args.org ?? null,
    p_provider: args.provider ?? null,
    p_bucket_key: args.key,
    p_capacity: args.capacity,
    p_refill_per_second: args.refill,
    ...(args.cost === undefined ? {} : { p_cost: args.cost }),
  });

afterAll(async () => {
  purgeIdempotencyKeys(run);
  // service_role a le droit de supprimer ses propres seaux.
  await api("service", "DELETE", `rate_limit_buckets?bucket_key=like.${run}*`);
});

describe("idempotency_begin / complete / abandon par la Data API", () => {
  it("parcourt new -> in_progress -> complete -> replay pour un membre", async () => {
    const key = `${run}-flow-1`;
    const hash = hashOf("flow-1");

    const attempt = await open("shared", ORG.alpha, key, hash);

    const again = await begin("shared", ORG.alpha, key, hash);
    expect(again.body).toEqual({ state: "in_progress" });

    const done = await complete("shared", ORG.alpha, key, attempt, 201, { id: "abc", replayed: false });
    expect(done.status).toBe(204);

    const replay = await begin("shared", ORG.alpha, key, hash);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ state: "replay", status_code: 201, response: { id: "abc", replayed: false } });
  });

  it("répond conflict pour un hash différent ou un autre acteur, sans rien divulguer", async () => {
    const key = `${run}-conflict-1`;
    const hash = hashOf("conflict-1");
    const attempt = await open("shared", ORG.alpha, key, hash);
    expect((await complete("shared", ORG.alpha, key, attempt, 200, { secretish: "valeur" })).status).toBe(204);

    const otherHash = await begin("shared", ORG.alpha, key, hashOf("autre contenu"));
    expect(otherHash.body).toEqual({ state: "conflict" });
    const otherActor = await begin("alphaSales", ORG.alpha, key, hash);
    expect(otherActor.body).toEqual({ state: "conflict" });
    expect(JSON.stringify(otherActor.body)).not.toContain("valeur");
  });

  it("refuse à un autre membre de conclure la clé d'autrui (invalid_state) et de la supprimer", async () => {
    const key = `${run}-actor-1`;
    const hash = hashOf("actor-1");
    const attempt = await open("shared", ORG.alpha, key, hash);

    // Même avec le BON attempt_id, un autre membre ne peut pas conclure ni supprimer la ligne d'autrui.
    const foreignComplete = await complete("alphaSales", ORG.alpha, key, attempt, 200, {});
    expect(foreignComplete.status).toBe(400);
    expect(foreignComplete.code).toBe("P0001");

    expect((await abandon("alphaSales", ORG.alpha, key, attempt)).status).toBe(204);
    // La ligne de l'acteur d'origine est intacte : un nouvel appel du même acteur la voit toujours.
    expect((await begin("shared", ORG.alpha, key, hash)).body).toEqual({ state: "in_progress" });
  });

  it("abandon : l'acteur libère sa clé, un nouvel essai repart avec new", async () => {
    const key = `${run}-abandon-1`;
    const hash = hashOf("abandon-1");
    const attempt = await open("shared", ORG.alpha, key, hash);
    expect((await abandon("shared", ORG.alpha, key, attempt)).status).toBe(204);
    await open("shared", ORG.alpha, key, hash);
  });

  it("valide les entrées (22023) et refuse un acteur sans adhésion avant toute validation (42501)", async () => {
    const badKey = await begin("shared", ORG.alpha, "x", hashOf("v"));
    expect(badKey.status).toBe(400);
    expect(badKey.code).toBe("22023");
    const badHash = await begin("shared", ORG.alpha, `${run}-valid-1`, "NOT-A-HASH");
    expect(badHash.code).toBe("22023");
    const badStatus = await complete("shared", ORG.alpha, `${run}-valid-1`, randomUuid(), 99, {});
    expect(badStatus.code).toBe("22023");
    const huge = await complete("shared", ORG.alpha, `${run}-valid-1`, randomUuid(), 200, { x: "a".repeat(70_000) });
    expect(huge.code).toBe("22023");
    const noAttempt = await complete("shared", ORG.alpha, `${run}-valid-1`, null, 200, {});
    expect(noAttempt.code).toBe("22023");
    expect((await abandon("shared", ORG.alpha, `${run}-valid-1`, null)).code).toBe("22023");

    const outsider = await begin("nobody", ORG.alpha, "x", "not-a-hash");
    expect(outsider.status).toBe(403);
    expect(outsider.code).toBe("42501");
  });

  it("isole les organisations : un membre de Beta ne peut rien faire chez Alpha, et inversement", async () => {
    const key = `${run}-iso-1`;
    const hash = hashOf("iso-1");

    const intoAlpha = await begin("betaOwner", ORG.alpha, key, hash);
    expect(intoAlpha.status).toBe(403);
    expect(intoAlpha.code).toBe("42501");
    expect((await complete("betaOwner", ORG.alpha, key, randomUuid(), 200, {})).code).toBe("42501");
    expect((await abandon("betaOwner", ORG.alpha, key, randomUuid())).code).toBe("42501");

    // `shared` est owner d'Alpha et sales_agent de Beta : la même clé est indépendante dans chaque organisation.
    await open("shared", ORG.alpha, key, hash);
    const betaAttempt = await open("betaOwner", ORG.beta, key, hash);
    expect((await complete("betaOwner", ORG.beta, key, betaAttempt, 200, { org: "beta" })).status).toBe(204);

    // Alpha n'a pas été affecté par la conclusion chez Beta.
    expect((await begin("shared", ORG.alpha, key, hash)).body).toEqual({ state: "in_progress" });
    // Un membre d'Alpha seulement ne peut pas rejouer la clé de Beta.
    const crossRead = await begin("alphaAdmin", ORG.beta, key, hash);
    expect(crossRead.code).toBe("42501");
  });

  it("refuse anon (401/403) et service_role (42501) sur toutes les fonctions idempotency_*", async () => {
    const args = { p_org: ORG.alpha, p_key: `${run}-denied-1`, p_request_hash: hashOf("denied") };
    for (const persona of ["anon", "service"] as const) {
      const b = await api(persona, "POST", "rpc/idempotency_begin", args);
      expect(isDenied(b), `${persona} begin`).toBe(true);
      const c = await api(persona, "POST", "rpc/idempotency_complete", {
        p_org: ORG.alpha, p_key: args.p_key, p_attempt_id: randomUuid(), p_status_code: 200, p_response: {},
      });
      expect(isDenied(c), `${persona} complete`).toBe(true);
      const a = await api(persona, "POST", "rpc/idempotency_abandon", {
        p_org: ORG.alpha, p_key: args.p_key, p_attempt_id: randomUuid(),
      });
      expect(isDenied(a), `${persona} abandon`).toBe(true);
    }
  });

  it("n'expose pas les fonctions private.* par la Data API", async () => {
    const result = await api("shared", "POST", "rpc/private.idempotency_begin", {});
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);
  });
});

describe("accès DIRECT aux tables : refusé", () => {
  const tables = ["idempotency_keys", "rate_limit_buckets"] as const;
  const row = {
    idempotency_keys: {
      organization_id: ORG.alpha, key: `${run}-direct-1`, actor_id: "00000000-0000-4000-8000-000000000001",
      request_hash: "a".repeat(64), state: "in_progress", expires_at: "2099-01-01T00:00:00Z",
    },
    rate_limit_buckets: { organization_id: ORG.alpha, bucket_key: `${run}-direct`, tokens: 10, refilled_at: "2026-01-01T00:00:00Z" },
  } as const;

  for (const table of tables) {
    it(`authenticated ne peut ni lire, ni insérer, ni modifier, ni supprimer ${table} (42501)`, async () => {
      for (const persona of ["shared", "alphaAdmin", "betaOwner"] as const) {
        const results = [
          await api(persona, "GET", `${table}?select=*`),
          await api(persona, "POST", table, row[table]),
          await api(persona, "PATCH", `${table}?organization_id=eq.${ORG.alpha}`, { organization_id: ORG.beta }),
          await api(persona, "DELETE", `${table}?organization_id=eq.${ORG.alpha}`),
        ];
        for (const result of results) {
          expect(isDenied(result), `${persona} ${table}`).toBe(true);
          expect(result.code).toBe("42501");
        }
      }
    });

    it(`anon ne peut rien faire sur ${table}`, async () => {
      const results = [
        await api("anon", "GET", `${table}?select=*`),
        await api("anon", "POST", table, row[table]),
        await api("anon", "PATCH", `${table}?organization_id=eq.${ORG.alpha}`, { organization_id: ORG.beta }),
        await api("anon", "DELETE", `${table}?organization_id=eq.${ORG.alpha}`),
      ];
      for (const result of results) expect(isDenied(result)).toBe(true);
    });
  }

  it("service_role n'a AUCUN droit direct sur idempotency_keys", async () => {
    const read = await api("service", "GET", "idempotency_keys?select=*");
    expect(isDenied(read)).toBe(true);
    expect(read.code).toBe("42501");
    expect(isDenied(await api("service", "POST", "idempotency_keys", row.idempotency_keys))).toBe(true);
    expect(isDenied(await api("service", "DELETE", `idempotency_keys?organization_id=eq.${ORG.alpha}`))).toBe(true);
  });

  it("service_role peut lire, écrire et supprimer ses seaux (select, insert, update, delete)", async () => {
    const key = `${run}-svc-crud`;
    const created = await api("service", "POST", "rate_limit_buckets", { ...row.rate_limit_buckets, bucket_key: key });
    expect(created.status).toBe(201);
    const read = await api<unknown[]>("service", "GET", `rate_limit_buckets?bucket_key=eq.${key}&select=tokens`);
    expect(read.status).toBe(200);
    expect(read.body).toEqual([{ tokens: 10 }]);
    const patched = await api("service", "PATCH", `rate_limit_buckets?bucket_key=eq.${key}`, { tokens: 3 });
    expect(patched.status).toBe(200);
    const removed = await api("service", "DELETE", `rate_limit_buckets?bucket_key=eq.${key}`);
    expect(removed.status).toBe(200);
  });
});

describe("rate_limit_take par la Data API", () => {
  it("n'est exécutable que par service_role", async () => {
    const args = { org: ORG.alpha, key: `${run}-who`, capacity: 5, refill: 1 };
    for (const persona of ["anon", "shared", "alphaAdmin", "betaOwner"] as const) {
      const result = await take(persona, args);
      expect(isDenied(result), persona).toBe(true);
      expect(result.code).toBe("42501");
    }
    const ok = await take("service", args);
    expect(ok.status).toBe(200);
    expect(ok.body.allowed).toBe(true);
    expect(ok.body.remaining).toBe(4);
    expect(ok.body.retry_after_seconds).toBe(0);
  });

  it("épuise un seau puis refuse avec retry_after >= 1", async () => {
    const args = { org: ORG.alpha, key: `${run}-drain`, capacity: 3, refill: 0.001 };
    for (let i = 0; i < 3; i += 1) expect((await take("service", args)).body.allowed).toBe(true);
    const denied = await take("service", args);
    expect(denied.status).toBe(200);
    expect(denied.body.allowed).toBe(false);
    expect(denied.body.retry_after_seconds).toBeGreaterThanOrEqual(1);
  });

  it("valide ses paramètres (22023) et exige une organisation ou un fournisseur", async () => {
    expect((await take("service", { org: ORG.alpha, key: `${run}-v`, capacity: 0, refill: 1 })).code).toBe("22023");
    expect((await take("service", { org: ORG.alpha, key: `${run}-v`, capacity: 10, refill: -1 })).code).toBe("22023");
    expect((await take("service", { org: ORG.alpha, key: `${run}-v`, capacity: 10, refill: 1, cost: 11 })).code).toBe("22023");
    expect((await take("service", { org: ORG.alpha, key: "user@example.com", capacity: 10, refill: 1 })).code).toBe("22023");
    expect((await take("service", { key: `${run}-v`, capacity: 10, refill: 1 })).code).toBe("22023");
    const provider = await take("service", { provider: "salla", key: `${run}-global`, capacity: 2, refill: 0 });
    expect(provider.status).toBe(200);
    expect(provider.body.allowed).toBe(true);
  });

  it("isole les seaux par clé et par organisation", async () => {
    const key = `${run}-isolate`;
    expect((await take("service", { org: ORG.alpha, key, capacity: 1, refill: 0 })).body.allowed).toBe(true);
    expect((await take("service", { org: ORG.alpha, key, capacity: 1, refill: 0 })).body.allowed).toBe(false);
    expect((await take("service", { org: ORG.beta, key, capacity: 1, refill: 0 })).body.allowed).toBe(true);
    expect((await take("service", { org: ORG.alpha, key: `${key}-other`, capacity: 1, refill: 0 })).body.allowed).toBe(true);
  });
});

describe("concurrence", () => {
  it("10 begin parallèles avec la même clé : exactement un `new`, les autres `in_progress`", async () => {
    const key = `${run}-race-1`;
    const hash = hashOf("race-1");
    const results = await Promise.all(Array.from({ length: 10 }, () => begin("shared", ORG.alpha, key, hash)));
    for (const result of results) expect(result.status).toBe(200);
    const states = results.map((r) => r.body.state);
    expect(states.filter((s) => s === "new")).toHaveLength(1);
    expect(states.filter((s) => s === "in_progress")).toHaveLength(9);
  });

  it("10 begin parallèles avec des hash différents : un seul `new`, les autres `conflict`", async () => {
    const key = `${run}-race-2`;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => begin("shared", ORG.alpha, key, hashOf(`race-2-${i}`))),
    );
    const states = results.map((r) => r.body.state);
    expect(states.filter((s) => s === "new")).toHaveLength(1);
    expect(states.filter((s) => s === "conflict")).toHaveLength(9);
  });

  it("50 rate_limit_take parallèles (capacité 10, recharge 0) : exactement 10 autorisés", async () => {
    const args = { org: ORG.alpha, key: `${run}-race-bucket`, capacity: 10, refill: 0 };
    const results = await Promise.all(Array.from({ length: 50 }, () => take("service", args)));
    for (const result of results) expect(result.status).toBe(200);
    expect(results.filter((r) => r.body.allowed)).toHaveLength(10);
    expect(results.filter((r) => !r.body.allowed)).toHaveLength(40);
  });
});

describe("attempt_id : un essai tardif ne touche pas la ligne du nouvel essai", () => {
  it("après une reprise (5 min), l'ancien essai ne peut ni conclure ni abandonner, le nouveau oui", async () => {
    const key = `${run}-late-1`;
    const hash = hashOf("late-1");
    const attemptA = await open("shared", ORG.alpha, key, hash);
    // Simule 6 minutes écoulées (service_role ne peut pas écrire cette table : passage par psql).
    psql(`update public.idempotency_keys set created_at = now() - interval '6 minutes' where key = '${key}';`);
    const attemptB = await open("shared", ORG.alpha, key, hash);
    expect(attemptB).not.toBe(attemptA);

    const lateComplete = await complete("shared", ORG.alpha, key, attemptA, 200, { late: true });
    expect(lateComplete.status).toBe(400);
    expect(lateComplete.code).toBe("P0001");
    expect((await abandon("shared", ORG.alpha, key, attemptA)).status).toBe(204);
    expect((await begin("shared", ORG.alpha, key, hash)).body).toEqual({ state: "in_progress" });

    const wrong = await complete("shared", ORG.alpha, key, randomUuid(), 200, {});
    expect(wrong.code).toBe("P0001");

    expect((await complete("shared", ORG.alpha, key, attemptB, 200, { done: true })).status).toBe(204);
    expect((await begin("shared", ORG.alpha, key, hash)).body).toEqual({
      state: "replay",
      status_code: 200,
      response: { done: true },
    });
    expect((await complete("shared", ORG.alpha, key, attemptA, 500, { late: true })).code).toBe("P0001");
  });
});

describe("plafond de la réponse stockée (16384 octets)", () => {
  // jsonb::text = {"x": "<n caractères>"} : 9 octets de structure + n.
  const padded = (total: number) => ({ x: "a".repeat(total - 9) });

  it("accepte 16384 octets et refuse 16385", async () => {
    const okKey = `${run}-cap-ok`;
    const koKey = `${run}-cap-ko`;
    const okAttempt = await open("alphaAdmin", ORG.alpha, okKey, hashOf("cap-ok"));
    const koAttempt = await open("alphaAdmin", ORG.alpha, koKey, hashOf("cap-ko"));
    expect((await complete("alphaAdmin", ORG.alpha, okKey, okAttempt, 200, padded(16384))).status).toBe(204);
    const tooBig = await complete("alphaAdmin", ORG.alpha, koKey, koAttempt, 200, padded(16385));
    expect(tooBig.status).toBe(400);
    expect(tooBig.code).toBe("22023");
  });
});

describe("purges (service_role seul)", () => {
  it("idempotency_purge supprime les lignes expirées (> 1 h) et les in_progress bloquées, conserve le reste", async () => {
    const k = (suffix: string) => `${run}-purge-${suffix}`;
    const hash = "a".repeat(64);
    const actor = "00000000-0000-4000-8000-000000000001";
    const alpha = ORG.alpha;
    psql(`
      insert into public.idempotency_keys (organization_id, key, actor_id, request_hash, state, status_code, response, expires_at, created_at) values
        ('${alpha}', '${k("exp2h")}', '${actor}', '${hash}', 'completed', 200, '{}', now() - interval '2 hours', now() - interval '26 hours'),
        ('${alpha}', '${k("exp30m")}', '${actor}', '${hash}', 'completed', 200, '{}', now() - interval '30 minutes', now() - interval '25 hours'),
        ('${alpha}', '${k("live")}', '${actor}', '${hash}', 'completed', 200, '{}', now() + interval '1 hour', now()),
        ('${alpha}', '${k("stale2h")}', '${actor}', '${hash}', 'in_progress', null, null, now() + interval '22 hours', now() - interval '2 hours'),
        ('${alpha}', '${k("ip30m")}', '${actor}', '${hash}', 'in_progress', null, null, now() + interval '23 hours', now() - interval '30 minutes');
    `);
    const purged = await api<number>("service", "POST", "rpc/idempotency_purge", { p_batch: 10000 });
    expect(purged.status).toBe(200);
    expect(purged.body).toBeGreaterThanOrEqual(2);
    const left = psql(`select key from public.idempotency_keys where key like '${run}-purge-%' order by key;`)
      .split("\n")
      .filter(Boolean);
    expect(left).toEqual([k("exp30m"), k("ip30m"), k("live")]);
  });

  it("rate_limit_purge supprime les seaux inactifs depuis plus de p_idle_days jours", async () => {
    const base = { organization_id: ORG.alpha, tokens: 1 };
    const created = await api("service", "POST", "rate_limit_buckets", [
      { ...base, bucket_key: `${run}-rlp-old`, refilled_at: new Date(Date.now() - 10 * 86_400_000).toISOString() },
      { ...base, bucket_key: `${run}-rlp-new`, refilled_at: new Date(Date.now() - 1 * 86_400_000).toISOString() },
    ]);
    expect(created.status).toBe(201);
    const purged = await api<number>("service", "POST", "rpc/rate_limit_purge", { p_idle_days: 7 });
    expect(purged.status).toBe(200);
    expect(purged.body).toBeGreaterThanOrEqual(1);
    const rows = await api<{ bucket_key: string }[]>(
      "service",
      "GET",
      `rate_limit_buckets?bucket_key=like.${run}-rlp*&select=bucket_key`,
    );
    expect(rows.body).toEqual([{ bucket_key: `${run}-rlp-new` }]);
  });

  it("valide ses paramètres (22023)", async () => {
    expect((await api("service", "POST", "rpc/idempotency_purge", { p_batch: 0 })).code).toBe("22023");
    expect((await api("service", "POST", "rpc/idempotency_purge", { p_batch: 10001 })).code).toBe("22023");
    expect((await api("service", "POST", "rpc/rate_limit_purge", { p_idle_days: 0 })).code).toBe("22023");
    expect((await api("service", "POST", "rpc/rate_limit_purge", { p_idle_days: 366 })).code).toBe("22023");
  });

  it("refuse anon et authenticated sur les deux purges", async () => {
    for (const persona of ["anon", "shared", "alphaAdmin", "betaOwner"] as const) {
      const a = await api(persona, "POST", "rpc/idempotency_purge", {});
      const b = await api(persona, "POST", "rpc/rate_limit_purge", {});
      expect(isDenied(a), `${persona} idempotency_purge`).toBe(true);
      expect(isDenied(b), `${persona} rate_limit_purge`).toBe(true);
    }
  });
});

describe("quota d'idempotence sous concurrence", () => {
  it("300 begin parallèles avec des clés distinctes (un acteur) : au plus 200 lignes vivantes, le reste quota_exceeded", async () => {
    const actor = "00000000-0000-4000-8000-000000000006"; // betaOwner, entreprise Beta (acteur isolé des autres tests)
    const liveCount = () =>
      Number(
        psql(
          `select count(*) from public.idempotency_keys where organization_id = '${ORG.beta}' and actor_id = '${actor}' and expires_at > now();`,
        ),
      );
    const before = liveCount();
    expect(before).toBeLessThan(200);
    // 300 appels au total ; au plus 60 requêtes HTTP en vol (Kong ferme les sockets au-delà), ce qui reste bien
    // au-dessus du pool PostgREST (10 connexions) : les begin se disputent réellement le verrou d'acteur.
    const results: Awaited<ReturnType<typeof begin>>[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: 60 }, async () => {
        while (next < 300) {
          const i = next++;
          results.push(await begin("betaOwner", ORG.beta, `${run}-qrace-${String(i).padStart(4, "0")}`, hashOf(`qrace-${i}`)));
        }
      }),
    );
    const created = results.filter((r) => r.status === 200 && (r.body as { state?: string }).state === "new").length;
    const refused = results.filter(
      (r) => r.status === 400 && (r.body as unknown as { message?: string }).message === "quota_exceeded",
    ).length;
    expect(created + refused).toBe(300);
    expect(liveCount()).toBeLessThanOrEqual(200);
    expect(liveCount()).toBe(before + created);
    expect(created).toBe(200 - before);
    expect(refused).toBe(300 - created);
  }, 120_000);
});

describe("quota d'idempotence (200 lignes vivantes par entreprise et acteur)", () => {
  // En dernier : remplit le quota de alphaMarketing chez Alpha (nettoyé par purgeIdempotencyKeys en afterAll).
  it("refuse la 201e ligne vivante (quota_exceeded) sans affecter un autre acteur", async () => {
    const actor = "00000000-0000-4000-8000-000000000003";
    const live = Number(
      psql(
        `select count(*) from public.idempotency_keys where organization_id = '${ORG.alpha}' and actor_id = '${actor}' and expires_at > now();`,
      ),
    );
    const missing = 199 - live;
    expect(missing).toBeGreaterThanOrEqual(0);
    psql(`
      insert into public.idempotency_keys (organization_id, key, actor_id, request_hash, state, expires_at)
      select '${ORG.alpha}', '${run}-quota-' || lpad(i::text, 5, '0'), '${actor}', repeat('a', 64), 'in_progress', now() + interval '12 hours'
        from generate_series(1, ${missing}) as i;
    `);

    expect(await open("alphaMarketing", ORG.alpha, `${run}-quota-200th`, hashOf("q200"))).toBeTruthy();
    const refused = await begin("alphaMarketing", ORG.alpha, `${run}-quota-201st`, hashOf("q201"));
    expect(refused.status).toBe(400);
    expect(refused.code).toBe("P0001");
    expect((refused.body as unknown as { message: string }).message).toBe("quota_exceeded");

    // Un autre acteur de la même entreprise n'est pas affecté.
    expect(await open("alphaSales", ORG.alpha, `${run}-quota-other`, hashOf("qo"))).toBeTruthy();
  });
});
