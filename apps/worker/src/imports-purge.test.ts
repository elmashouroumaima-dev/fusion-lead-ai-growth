import { describe, expect, it, vi } from "vitest";
import { purgeImportFiles, startImportPurge, type ImportPurgeGateway } from "./imports-purge";

const ORG = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";

function gateway(over: Partial<ImportPurgeGateway> = {}): ImportPurgeGateway & { removed: string[][]; purged: string[] } {
  const removed: string[][] = [];
  const purged: string[] = [];
  return {
    removed,
    purged,
    expireStale: async () => 0,
    filesDue: async () => [],
    markPurged: async (_org, batch) => {
      purged.push(batch);
    },
    orphanFiles: async () => [],
    removeFiles: async (paths) => {
      removed.push(paths);
      return true;
    },
    ...over,
  };
}

describe("purge des fichiers d'import (S-09)", () => {
  it("annule les lots abandonnés, retire le fichier des lots terminés puis le marque purgé, retire les objets orphelins", async () => {
    const g = gateway({
      expireStale: async () => 3,
      filesDue: async () => [{ organizationId: ORG, batchId: BATCH, path: `${ORG}/${BATCH}.csv` }],
      orphanFiles: async () => [`${ORG}/orphelin.csv`],
    });
    expect(await purgeImportFiles(g)).toEqual({ expired: 3, purged: 1, orphans: 1, failures: 0 });
    expect(g.removed).toEqual([[`${ORG}/${BATCH}.csv`], [`${ORG}/orphelin.csv`]]);
    expect(g.purged).toEqual([BATCH]);
  });

  it("rien à faire : aucun appel au Storage", async () => {
    const g = gateway();
    expect(await purgeImportFiles(g)).toEqual({ expired: 0, purged: 0, orphans: 0, failures: 0 });
    expect(g.removed).toEqual([]);
  });

  it("le Storage répond en erreur : le lot n'est PAS marqué purgé (la prochaine tentative reprend), aucune exception", async () => {
    const g = gateway({
      filesDue: async () => [{ organizationId: ORG, batchId: BATCH, path: "x.csv" }],
      removeFiles: async () => false,
    });
    expect(await purgeImportFiles(g)).toMatchObject({ purged: 0, failures: 1 });
    expect(g.purged).toEqual([]);
  });

  it("une panne d'une étape (base) n'empêche pas les suivantes ; jamais d'exception", async () => {
    const g = gateway({
      expireStale: async () => {
        throw new Error("expire_failed");
      },
      filesDue: async () => {
        throw new Error("due_failed");
      },
      orphanFiles: async () => ["o.csv"],
    });
    expect(await purgeImportFiles(g)).toEqual({ expired: 0, purged: 0, orphans: 1, failures: 2 });
  });

  it("un échec de marquage d'un lot est compté, les autres lots sont marqués", async () => {
    const g = gateway({
      filesDue: async () => [
        { organizationId: ORG, batchId: BATCH, path: "a.csv" },
        { organizationId: ORG, batchId: "33333333-3333-4333-8333-333333333333", path: "b.csv" },
      ],
      markPurged: async (_org, batch) => {
        if (batch === BATCH) throw new Error("mark_failed");
      },
    });
    expect(await purgeImportFiles(g)).toMatchObject({ purged: 1, failures: 1 });
  });
});

describe("planificateur de la purge", () => {
  it("s'exécute au démarrage puis à chaque intervalle ; une exécution en cours n'est pas doublée ; le journal ne porte que des nombres", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const g = gateway({
        expireStale: async () => {
          calls += 1;
          return 2;
        },
      });
      const info = vi.fn();
      const stop = startImportPurge(g, { info, warn: vi.fn(), error: vi.fn() }, 1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(2500);
      expect(calls).toBe(3);
      expect(info).toHaveBeenCalledWith("import_purge", { expired: 2, purged: 0, orphans: 0, failures: 0 });
      stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
