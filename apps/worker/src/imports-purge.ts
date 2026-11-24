import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { WorkerLogger } from "./runner";

/**
 * Purge des fichiers d'import (S-09, ADR 007 J23) : un fichier CSV contient des données personnelles ; il n'a plus d'utilité une fois le lot terminé. Toutes les
 * 15 minutes le worker (1) annule les lots restés « uploaded » plus de 24 h (ils occupaient les 10 places d'import en cours), (2) retire du Storage le fichier des lots
 * terminés (fait, échec, annulé) puis le marque purgé, (3) retire les objets du bucket sans lot correspondant (échec de la création du lot après l'envoi).
 * Idempotente : deux workers qui purgent en même temps ne font qu'un retrait de plus ; un fichier déjà absent est marqué purgé. Aucune erreur ne remonte : la purge
 * est un effort, la tentative suivante reprend. Aucun chemin, identifiant ni contenu dans les journaux : des nombres seulement.
 */
export interface ImportPurgeGateway {
  expireStale(): Promise<number>;
  filesDue(limit: number): Promise<Array<{ organizationId: string; batchId: string; path: string }>>;
  markPurged(organizationId: string, batchId: string): Promise<void>;
  orphanFiles(limit: number): Promise<string[]>;
  /** Retire des objets du bucket des imports ; `true` si le Storage a répondu sans erreur (même si un objet était déjà absent). */
  removeFiles(paths: string[]): Promise<boolean>;
}

export type PurgeResult = { expired: number; purged: number; orphans: number; failures: number };

const BATCH = 200;

export async function purgeImportFiles(gateway: ImportPurgeGateway): Promise<PurgeResult> {
  const result: PurgeResult = { expired: 0, purged: 0, orphans: 0, failures: 0 };
  try {
    result.expired = await gateway.expireStale();
  } catch {
    result.failures += 1;
  }
  try {
    const due = await gateway.filesDue(BATCH);
    if (due.length > 0) {
      if (await gateway.removeFiles(due.map((d) => d.path))) {
        for (const item of due) {
          try {
            await gateway.markPurged(item.organizationId, item.batchId);
            result.purged += 1;
          } catch {
            result.failures += 1;
          }
        }
      } else {
        result.failures += 1;
      }
    }
  } catch {
    result.failures += 1;
  }
  try {
    const orphans = await gateway.orphanFiles(BATCH);
    if (orphans.length > 0) {
      if (await gateway.removeFiles(orphans)) result.orphans = orphans.length;
      else result.failures += 1;
    }
  } catch {
    result.failures += 1;
  }
  return result;
}

const dueSchema = z.array(z.object({ organization_id: z.uuid(), batch_id: z.uuid(), file_path: z.string().min(1).max(300) }));
const namesSchema = z.array(z.object({ name: z.string().min(1).max(300) }));

export type PurgeEnv = { SUPABASE_URL: string; SUPABASE_SECRET_KEY: string };

/** Accès service_role : fonctions `import_*` de la migration S-09 et API du Storage. Erreurs opaques. */
export function createSupabaseImportPurgeGateway(env: PurgeEnv): ImportPurgeGateway {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  return {
    async expireStale() {
      const { data, error } = await client.rpc("import_expire_stale");
      if (error || typeof data !== "number") throw new Error("expire_failed");
      return data;
    },
    async filesDue(limit) {
      const { data, error } = await client.rpc("import_files_due", { p_limit: limit });
      const parsed = dueSchema.safeParse(data);
      if (error || !parsed.success) throw new Error("due_failed");
      return parsed.data.map((row) => ({ organizationId: row.organization_id, batchId: row.batch_id, path: row.file_path }));
    },
    async markPurged(organizationId, batchId) {
      const { error } = await client.rpc("import_file_purged", { p_org: organizationId, p_batch: batchId });
      if (error) throw new Error("mark_failed");
    },
    async orphanFiles(limit) {
      const { data, error } = await client.rpc("import_orphan_files", { p_limit: limit });
      const parsed = namesSchema.safeParse(data);
      if (error || !parsed.success) throw new Error("orphans_failed");
      return parsed.data.map((row) => row.name);
    },
    async removeFiles(paths) {
      const { error } = await client.storage.from("imports").remove(paths);
      return !error;
    },
  };
}

export const IMPORT_PURGE_INTERVAL_MS = 15 * 60 * 1000;

/** Lance la purge au démarrage puis toutes les 15 minutes ; renvoie l'arrêt (appelé à l'extinction du worker). Le minuteur ne retient pas le processus. */
export function startImportPurge(gateway: ImportPurgeGateway, logger: WorkerLogger, intervalMs: number = IMPORT_PURGE_INTERVAL_MS): () => void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await purgeImportFiles(gateway);
      if (result.expired + result.purged + result.orphans + result.failures > 0) logger.info("import_purge", result);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
