import { MemoryWebhooks } from "./webhooks.testkit";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MemoryAssigner } from "./assigner.testkit";
import { MemoryCrm } from "./crm-sync.testkit";
import { MemoryImports } from "./imports.testkit";
import { NonRetryableError } from "./errors";
import { createDefaultRegistry, defineHandler, HandlerRegistry } from "./handlers";
import { MemoryStore } from "./memory-store.testkit";
import { Runner, type WorkerLogger } from "./runner";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const anyPayload = z.record(z.string(), z.unknown());

function capture() {
  const lines: string[] = [];
  const logger: WorkerLogger = {
    info: (e, f) => lines.push(JSON.stringify({ e, ...f })),
    warn: (e, f) => lines.push(JSON.stringify({ e, ...f })),
    error: (e, f) => lines.push(JSON.stringify({ e, ...f })),
  };
  return { lines, logger };
}

describe("Runner : exécution", () => {
  it("exécute un job noop puis le clôt en succès", async () => {
    const store = new MemoryStore();
    store.add({ id: ID(1) });
    const runner = new Runner({ store, registry: createDefaultRegistry({ assigner: new MemoryAssigner(), imports: new MemoryImports(), crm: new MemoryCrm(), webhooks: { gateway: new MemoryWebhooks(), processors: new Map() } }), workerId: "w1" });
    expect(await runner.tick()).toBe(1);
    await runner.idle();
    expect(store.jobs.get(ID(1))?.status).toBe("succeeded");
    expect(store.calls.complete).toBe(1);
  });

  it("type inconnu : échec définitif, code unknown_kind", async () => {
    const store = new MemoryStore();
    store.add({ id: ID(1), kind: "inconnu" });
    const runner = new Runner({ store, registry: createDefaultRegistry({ assigner: new MemoryAssigner(), imports: new MemoryImports(), crm: new MemoryCrm(), webhooks: { gateway: new MemoryWebhooks(), processors: new Map() } }), workerId: "w1" });
    await runner.tick();
    await runner.idle();
    expect(store.jobs.get(ID(1))).toMatchObject({ status: "dead_letter", lastError: "unknown_kind", retryable: false });
  });

  it("charge utile invalide : échec définitif, code invalid_payload", async () => {
    const store = new MemoryStore();
    store.add({ id: ID(1), kind: "strict", payload: { nope: true } });
    const registry = new HandlerRegistry().register(
      defineHandler({ kind: "strict", schema: z.object({ contact_id: z.string() }).strict(), run: async () => {} }),
    );
    const runner = new Runner({ store, registry, workerId: "w1" });
    await runner.tick();
    await runner.idle();
    expect(store.jobs.get(ID(1))).toMatchObject({ status: "dead_letter", lastError: "invalid_payload", retryable: false });
  });

  it("erreur reprenable : seul le NOM de l'erreur est transmis, jamais son message", async () => {
    const store = new MemoryStore();
    store.add({ id: ID(1), kind: "boom" });
    const registry = new HandlerRegistry().register(
      defineHandler({
        kind: "boom",
        schema: anyPayload,
        run: async () => {
          throw new TypeError("contact jean@example.com token=abc123");
        },
      }),
    );
    const { lines, logger } = capture();
    const runner = new Runner({ store, registry, workerId: "w1", logger });
    await runner.tick();
    await runner.idle();
    expect(store.jobs.get(ID(1))).toMatchObject({ status: "queued", lastError: "TypeError", retryable: true });
    expect(JSON.stringify([...store.jobs.values()])).not.toContain("jean@example.com");
    expect(lines.join("\n")).not.toContain("jean@example.com");
    expect(lines.join("\n")).not.toContain("abc123");
  });

  it("NonRetryableError : dead_letter immédiat avec son code", async () => {
    const store = new MemoryStore();
    store.add({ id: ID(1), kind: "stop" });
    const registry = new HandlerRegistry().register(
      defineHandler({
        kind: "stop",
        schema: anyPayload,
        run: async () => {
          throw new NonRetryableError("contact_do_not_contact");
        },
      }),
    );
    const runner = new Runner({ store, registry, workerId: "w1" });
    await runner.tick();
    await runner.idle();
    expect(store.jobs.get(ID(1))).toMatchObject({ status: "dead_letter", lastError: "contact_do_not_contact", retryable: false });
  });

  it("essais épuisés par erreurs reprenables : dead_letter", async () => {
    const store = new MemoryStore();
    store.add({ id: ID(1), kind: "boom", maxAttempts: 2 });
    const registry = new HandlerRegistry().register(
      defineHandler({
        kind: "boom",
        schema: anyPayload,
        run: async () => {
          throw new Error("x");
        },
      }),
    );
    const runner = new Runner({ store, registry, workerId: "w1" });
    for (let i = 0; i < 3; i++) {
      await runner.tick();
      await runner.idle();
    }
    expect(store.jobs.get(ID(1))).toMatchObject({ status: "dead_letter", attempts: 2 });
  });

  it("le handler reçoit l'organisation de la LIGNE du job, jamais celle de la charge utile", async () => {
    const store = new MemoryStore();
    store.add({ id: ID(1), kind: "ctx", organizationId: "22222222-2222-4222-8222-222222222222", payload: { organization_id: "evil" } });
    let seen = "";
    const registry = new HandlerRegistry().register(
      defineHandler({
        kind: "ctx",
        schema: anyPayload,
        run: async (ctx) => {
          seen = ctx.organizationId;
        },
      }),
    );
    const runner = new Runner({ store, registry, workerId: "w1" });
    await runner.tick();
    await runner.idle();
    expect(seen).toBe("22222222-2222-4222-8222-222222222222");
  });
});

describe("Runner : concurrence", () => {
  it("ne dépasse jamais la concurrence demandée", async () => {
    const store = new MemoryStore();
    for (let i = 1; i <= 6; i++) store.add({ id: ID(i), kind: "slow" });
    let current = 0;
    let max = 0;
    const registry = new HandlerRegistry().register(
      defineHandler({
        kind: "slow",
        schema: anyPayload,
        run: async () => {
          current += 1;
          max = Math.max(max, current);
          await wait(15);
          current -= 1;
        },
      }),
    );
    const runner = new Runner({ store, registry, workerId: "w1", concurrency: 2, pollMs: 2 });
    runner.start();
    await wait(200);
    await runner.stop();
    expect(max).toBe(2);
    expect([...store.jobs.values()].every((j) => j.status === "succeeded")).toBe(true);
  });

  it("trois workers sur la même file : chaque job est exécuté exactement une fois", async () => {
    const store = new MemoryStore();
    for (let i = 1; i <= 30; i++) store.add({ id: ID(i), kind: "count" });
    const runs = new Map<string, number>();
    const registry = new HandlerRegistry().register(
      defineHandler({
        kind: "count",
        schema: anyPayload,
        run: async (ctx) => {
          runs.set(ctx.jobId, (runs.get(ctx.jobId) ?? 0) + 1);
          await wait(3);
        },
      }),
    );
    const workers = ["wa", "wb", "wc"].map((id) => new Runner({ store, registry, workerId: id, concurrency: 3, pollMs: 2 }));
    workers.forEach((w) => w.start());
    await wait(250);
    await Promise.all(workers.map((w) => w.stop()));
    expect(runs.size).toBe(30);
    expect([...runs.values()].every((n) => n === 1)).toBe(true);
  });
});

describe("Runner : bail et heartbeat", () => {
  it("bail perdu : le handler est interrompu et le worker n'écrit plus rien", async () => {
    const store = new MemoryStore();
    store.add({ id: ID(1), kind: "long" });
    store.heartbeatResult = false;
    let aborted = false;
    const registry = new HandlerRegistry().register(
      defineHandler({
        kind: "long",
        schema: anyPayload,
        run: async (ctx) => {
          await new Promise<void>((resolve) =>
            ctx.signal.addEventListener("abort", () => {
              aborted = true;
              resolve();
            }),
          );
        },
      }),
    );
    const runner = new Runner({ store, registry, workerId: "w1", leaseSeconds: 5, heartbeatMs: 5 });
    await runner.tick();
    await runner.idle();
    expect(aborted).toBe(true);
    expect(store.calls.complete).toBe(0);
    expect(store.calls.fail).toBe(0);
  });

  it("envoie des heartbeats pendant un job long", async () => {
    const store = new MemoryStore();
    store.add({ id: ID(1), kind: "wait" });
    const registry = new HandlerRegistry().register(
      defineHandler({
        kind: "wait",
        schema: anyPayload,
        run: async () => {
          await wait(40);
        },
      }),
    );
    const runner = new Runner({ store, registry, workerId: "w1", leaseSeconds: 5, heartbeatMs: 8 });
    await runner.tick();
    await runner.idle();
    expect(store.calls.heartbeat).toBeGreaterThanOrEqual(2);
    expect(store.jobs.get(ID(1))?.status).toBe("succeeded");
  });
});

describe("Runner : arrêt propre", () => {
  it("attend les jobs en cours, ne réclame plus rien", async () => {
    const store = new MemoryStore();
    store.add({ id: ID(1), kind: "wait" });
    store.add({ id: ID(2), kind: "wait" });
    const registry = new HandlerRegistry().register(
      defineHandler({
        kind: "wait",
        schema: anyPayload,
        run: async () => {
          await wait(40);
        },
      }),
    );
    const runner = new Runner({ store, registry, workerId: "w1", concurrency: 1, pollMs: 2 });
    runner.start();
    await wait(10);
    const result = await runner.stop();
    expect(result).toEqual({ timedOut: false, abandoned: 0 });
    expect(store.jobs.get(ID(1))?.status).toBe("succeeded");
    expect(store.jobs.get(ID(2))?.status).toBe("queued"); // jamais réclamé après l'arrêt
    const claims = store.calls.claim;
    await wait(20);
    expect(store.calls.claim).toBe(claims);
    expect(await runner.tick()).toBe(0);
  });

  it("délai dépassé : abandon des jobs restants (signal d'arrêt, bail laissé expirer)", async () => {
    const store = new MemoryStore();
    store.add({ id: ID(1), kind: "stuck" });
    let aborted = false;
    const registry = new HandlerRegistry().register(
      defineHandler({
        kind: "stuck",
        schema: anyPayload,
        run: async (ctx) => {
          await new Promise<void>((resolve) =>
            ctx.signal.addEventListener("abort", () => {
              aborted = true;
              resolve();
            }),
          );
        },
      }),
    );
    const runner = new Runner({ store, registry, workerId: "w1", shutdownTimeoutMs: 20, pollMs: 2 });
    runner.start();
    await wait(10);
    const result = await runner.stop();
    expect(result).toEqual({ timedOut: true, abandoned: 1 });
    await wait(5);
    expect(aborted).toBe(true);
    // Arrêt forcé : aucune tentative consommée (ni fail ni complete), le bail expirera.
    expect(store.calls.fail).toBe(0);
    expect(store.calls.complete).toBe(0);
    expect(store.jobs.get(ID(1))?.status).toBe("running");
  });
});

describe("Runner : robustesse", () => {
  it("une erreur de la base ne tue pas la boucle : elle réessaie", async () => {
    const store = new MemoryStore();
    store.add({ id: ID(1) });
    store.failClaim = 2;
    const { lines, logger } = capture();
    const runner = new Runner({ store, registry: createDefaultRegistry({ assigner: new MemoryAssigner(), imports: new MemoryImports(), crm: new MemoryCrm(), webhooks: { gateway: new MemoryWebhooks(), processors: new Map() } }), workerId: "w1", pollMs: 3, logger });
    runner.start();
    await wait(80);
    await runner.stop();
    expect(store.jobs.get(ID(1))?.status).toBe("succeeded");
    expect(lines.filter((l) => l.includes("claim_failed")).length).toBe(2);
    expect(lines.join("\n")).not.toContain("db down");
  });

  it("le journal ne contient jamais la charge utile", async () => {
    const store = new MemoryStore();
    store.add({ id: ID(1), payload: { email: "marie@example.com", note: "texte du message" } });
    const { lines, logger } = capture();
    const runner = new Runner({ store, registry: createDefaultRegistry({ assigner: new MemoryAssigner(), imports: new MemoryImports(), crm: new MemoryCrm(), webhooks: { gateway: new MemoryWebhooks(), processors: new Map() } }), workerId: "w1", logger });
    await runner.tick();
    await runner.idle();
    expect(lines.join("\n")).not.toContain("marie@example.com");
    expect(lines.join("\n")).not.toContain("texte du message");
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe("Runner : délai maximal et enregistrement du succès", () => {
  it("handler qui ignore le signal : échec HandlerTimeout reprenable, emplacement libéré", async () => {
    const store = new MemoryStore();
    store.add({ id: ID(1), kind: "hang" });
    const registry = new HandlerRegistry().register(
      defineHandler({ kind: "hang", schema: anyPayload, run: () => new Promise<void>(() => {}) }),
    );
    const runner = new Runner({ store, registry, workerId: "w1", handlerTimeoutMs: 20, leaseSeconds: 5 });
    await runner.tick();
    await runner.idle();
    expect(store.jobs.get(ID(1))).toMatchObject({ status: "queued", lastError: "HandlerTimeout", retryable: true });
    expect(runner.activeJobs).toBe(0);
  });

  it("complete qui échoue après un succès : aucun échec déclaré (le bail expirera)", async () => {
    const store = new MemoryStore();
    store.add({ id: ID(1) });
    store.complete = async () => {
      throw new Error("réseau");
    };
    const { lines, logger } = capture();
    const runner = new Runner({ store, registry: createDefaultRegistry({ assigner: new MemoryAssigner(), imports: new MemoryImports(), crm: new MemoryCrm(), webhooks: { gateway: new MemoryWebhooks(), processors: new Map() } }), workerId: "w1", logger });
    await runner.tick();
    await runner.idle();
    expect(store.calls.fail).toBe(0);
    expect(lines.some((l) => l.includes("job_complete_unrecorded"))).toBe(true);
    expect(lines.join("\n")).not.toContain("réseau");
  });
});
