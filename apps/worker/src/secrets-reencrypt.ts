import {
  decryptSecret,
  encryptSecret,
  fingerprintSecret,
  organizationSecretAad,
  platformSecretAad,
  type KeyRing,
} from "@fusion-leap/adapters";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { WorkerLogger } from "./runner";

/**
 * Rechiffrement des secrets après une rotation de la clé maître (S-11, ADR 004). Le trousseau contient la clé courante (qui chiffre) et les anciennes clés
 * `SECRETS_PREVIOUS_KEYS` (qui déchiffrent). Toutes les 15 minutes le worker lit les secrets chiffrés avec une AUTRE version de clé (et les jetons / secrets de
 * webhook sans empreinte, S-12), les déchiffre en mémoire, les rechiffre avec la clé courante (même identifiant, mêmes données associées, nouveau nonce), recalcule
 * l'empreinte S-12 (elle dépend de la clé courante), puis les écrit SEULEMENT si la ligne n'a pas changé depuis la lecture : une rotation de jeton faite pendant ce
 * temps n'est jamais écrasée. Quand plus rien n'est à rechiffrer, l'ancienne clé peut être retirée de `SECRETS_PREVIOUS_KEYS` (runbook `secret-rotation.md`).
 * Aucune erreur ne remonte ; aucun texte clair, identifiant ni chiffré dans les journaux : des nombres seulement.
 */
export type SecretRow = { id: string; purpose: string; organizationId: string | null; ciphertext: string; nonce: string; keyVersion: number };
export type SealedSecret = { ciphertext: string; nonce: string; keyVersion: number };

export interface SecretsReencryptGateway {
  due(currentVersion: number, limit: number): Promise<SecretRow[]>;
  /** Écrit le nouveau chiffré si la ligne n'a pas changé (même version et même chiffré) ; `false` sinon. */
  write(row: SecretRow, sealed: SealedSecret, fingerprint: string | null): Promise<boolean>;
}

export type ReencryptResult = { rewritten: number; changed: number; failures: number };

const BATCH = 100;
const MAX_BATCHES_PER_RUN = 5;
const INTEGRATION_PURPOSES = new Set(["integration", "integration_webhook"]);

function aadFor(row: SecretRow): string | null {
  if (INTEGRATION_PURPOSES.has(row.purpose)) return row.organizationId === null ? null : organizationSecretAad(row.organizationId, row.id);
  if (row.purpose === "smtp") return platformSecretAad("smtp", row.id);
  return null;
}

export async function reencryptSecrets(gateway: SecretsReencryptGateway, keyRing: KeyRing): Promise<ReencryptResult> {
  const result: ReencryptResult = { rewritten: 0, changed: 0, failures: 0 };
  // une ligne qui échoue reviendrait à chaque lot : elle est comptée une fois et ignorée pour la suite du passage
  const failed = new Set<string>();
  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
    let rows: SecretRow[];
    try {
      rows = await gateway.due(keyRing.current, BATCH);
    } catch {
      result.failures += 1;
      return result;
    }
    const todo = rows.filter((row) => !failed.has(row.id));
    if (todo.length === 0) return result;
    for (const row of todo) {
      try {
        const aad = aadFor(row);
        if (aad === null) throw new Error("unknown_purpose");
        const plaintext = decryptSecret({ secret: { ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.keyVersion }, keyRing, aad });
        const sealed = encryptSecret({ plaintext, keyRing, aad });
        const fingerprint = INTEGRATION_PURPOSES.has(row.purpose) ? fingerprintSecret({ plaintext, keyRing }) : null;
        if (await gateway.write(row, sealed, fingerprint)) result.rewritten += 1;
        else result.changed += 1;
      } catch {
        failed.add(row.id);
        result.failures += 1;
      }
    }
  }
  return result;
}

const rowsSchema = z.array(
  z.object({
    id: z.uuid(),
    purpose: z.string().min(1).max(32),
    organization_id: z.uuid().nullable(),
    ciphertext: z.string().min(1),
    nonce: z.string().min(1),
    key_version: z.number().int().min(1).max(1000),
  }),
);

export type ReencryptEnv = { SUPABASE_URL: string; SUPABASE_SECRET_KEY: string };

/** Accès service_role : fonctions `secrets_reencrypt_due` et `secret_reencrypted` de la migration S-11. Erreurs opaques. */
export function createSupabaseSecretsReencryptGateway(env: ReencryptEnv): SecretsReencryptGateway {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  return {
    async due(currentVersion, limit) {
      const { data, error } = await client.rpc("secrets_reencrypt_due", { p_current_version: currentVersion, p_limit: limit });
      const parsed = rowsSchema.safeParse(data);
      if (error || !parsed.success) throw new Error("due_failed");
      return parsed.data.map((r) => ({ id: r.id, purpose: r.purpose, organizationId: r.organization_id, ciphertext: r.ciphertext, nonce: r.nonce, keyVersion: r.key_version }));
    },
    async write(row, sealed, fingerprint) {
      const { data, error } = await client.rpc("secret_reencrypted", {
        p_id: row.id,
        p_old_key_version: row.keyVersion,
        p_old_ciphertext: row.ciphertext,
        p_ciphertext: sealed.ciphertext,
        p_nonce: sealed.nonce,
        p_key_version: sealed.keyVersion,
        p_fingerprint: fingerprint,
      });
      if (error || typeof data !== "boolean") throw new Error("write_failed");
      return data;
    },
  };
}

export const SECRETS_REENCRYPT_INTERVAL_MS = 15 * 60 * 1000;

/** Lance le rechiffrement au démarrage puis toutes les 15 minutes ; renvoie l'arrêt. Le minuteur ne retient pas le processus. */
export function startSecretsReencrypt(
  gateway: SecretsReencryptGateway,
  keyRing: KeyRing,
  logger: WorkerLogger,
  intervalMs: number = SECRETS_REENCRYPT_INTERVAL_MS,
): () => void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await reencryptSecrets(gateway, keyRing);
      if (result.rewritten + result.changed + result.failures > 0) logger.info("secrets_reencrypt", { ...result, key_version: keyRing.current });
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
