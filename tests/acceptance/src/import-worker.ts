import { randomUUID } from "node:crypto";
import { createImportCsvHandler } from "../../../apps/worker/src/handlers";
import type { ImportGateway, ImportStart } from "../../../apps/worker/src/imports";
import { api, downloadAsService, psql } from "../../../supabase/tests/rls/src/harness";

/**
 * Worker d'import pour les scénarios d'acceptation : passerelle de test (mêmes fonctions SQL que le worker, rôle service_role,
 * fichier lu dans le Storage réel) et exécution du VRAI handler `import_csv`. Partagé par `import-flow` (J23) et `t2-sales` (J26).
 */
export const importGateway: ImportGateway = {
  async start(org, batch) {
    const result = await api<Record<string, unknown>>("service", "POST", "rpc/import_start", { p_org: org, p_batch: batch });
    const body = result.body as { status: string; path?: string; mapping?: Record<string, number>; default_country?: string | null; project_id?: string };
    if (body.status !== "running") return { status: body.status } as ImportStart;
    return { status: "running", path: body.path as string, mapping: body.mapping as never, defaultCountry: body.default_country ?? null, projectId: body.project_id as string };
  },
  readFile: (path) => downloadAsService("imports", path),
  async row(org, batch, rowNo, value) {
    const result = await api<{ outcome: never; reason: string | null; lead_created: boolean }>("service", "POST", "rpc/import_row", {
      p_org: org, p_batch: batch, p_row: rowNo, p_name: value.name, p_email_raw: value.email_raw, p_email_normalized: value.email_normalized,
      p_phone_e164: value.phone_e164, p_language: value.language, p_country: value.country,
    });
    if (result.status !== 200) throw new Error(`import_row_${result.status}`);
    return { outcome: result.body.outcome, reason: result.body.reason, leadCreated: result.body.lead_created };
  },
  async rowError(org, batch, rowNo, reason) {
    const result = await api("service", "POST", "rpc/import_record_error", { p_org: org, p_batch: batch, p_row: rowNo, p_reason: reason });
    if (result.status >= 300) throw new Error("import_row_error_failed");
  },
  async finish(org, batch, rowCount) {
    const result = await api("service", "POST", "rpc/import_finish", { p_org: org, p_batch: batch, p_rows: rowCount });
    if (result.status >= 300) throw new Error("import_finish_failed");
  },
  async fail(org, batch, code) {
    await api("service", "POST", "rpc/import_fail", { p_org: org, p_batch: batch, p_code: code });
  },
};

/** Ce que fait le worker pour le job `import_csv` : l'entreprise vient de la LIGNE du job, jamais de la charge utile. */
export async function runImportJob(batch: string): Promise<void> {
  const org = psql(`select organization_id from public.jobs where kind = 'import_csv' and payload ->> 'batch_id' = '${batch}'`);
  await createImportCsvHandler(importGateway).run(
    { jobId: randomUUID(), organizationId: org, idempotencyKey: `import_csv:${batch}`, attempt: 1, maxAttempts: 5, signal: new AbortController().signal },
    { batch_id: batch },
  );
}
