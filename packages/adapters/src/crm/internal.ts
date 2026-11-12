import type { CrmAdapter, CrmAdapterResult, CrmReceiveResult, CrmRecord, CrmSendResult } from "./types";

/**
 * Adaptateur `internal` : le CRM interne EST la source de vérité du MVP (spec §9.1, docs/integrations/crm.md). Il n'envoie rien à
 * l'extérieur et n'importe rien : il existe pour que le reste du code manipule toujours une `CrmAdapter`, jamais un cas particulier.
 */
export class InternalCrmAdapter implements CrmAdapter {
  readonly provider = "internal" as const;

  async connect(): Promise<CrmAdapterResult> {
    return { ok: true };
  }
  async validate(): Promise<CrmAdapterResult> {
    return { ok: true };
  }
  async send(records: readonly CrmRecord[]): Promise<CrmSendResult> {
    return { accepted: 0, skipped: records.length };
  }
  async receive(): Promise<CrmReceiveResult> {
    return { records: [], rejected: [], missingColumns: [] };
  }
  async refresh(): Promise<CrmAdapterResult> {
    return { ok: true };
  }
  async disconnect(): Promise<void> {}
}
