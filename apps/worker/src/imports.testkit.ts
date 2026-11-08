import type { ImportRowValue } from "@fusion-leap/domain";
import { ImportGatewayError, type ImportFailCode, type ImportGateway, type ImportRowOutcome, type ImportStart } from "./imports";

/**
 * Passerelle d'import en mémoire pour les tests : reproduit l'idempotence par ligne de la base (une ligne n'est enregistrée qu'une
 * fois), enregistre tous les appels et peut échouer à la demande.
 */
export class MemoryImports implements ImportGateway {
  startResult: ImportStart = {
    status: "running",
    path: "org/batch.csv",
    mapping: { name: 0, email: 1, phone: 2 },
    defaultCountry: "MA",
    projectId: "55555555-5555-4555-8555-555555555555",
  };
  file: Uint8Array | null = new TextEncoder().encode("nom,email,tel\nA,a@x.com,\n");
  readonly rows = new Map<number, ImportRowOutcome>();
  readonly values = new Map<number, ImportRowValue>();
  readonly errors = new Map<number, string>();
  readonly calls = { start: 0, read: 0, row: 0, rowError: 0 };
  finished: { org: string; batch: string; rows: number } | null = null;
  failed: ImportFailCode | null = null;
  /** Numéro de ligne à partir duquel `row` échoue (panne technique), ou null. */
  failRowFrom: number | null = null;
  failKind: "failed" | "subscription_inactive" | "project_archived" = "failed";
  failFail = false;

  async start(): Promise<ImportStart> {
    this.calls.start += 1;
    return this.startResult;
  }

  async readFile(): Promise<Uint8Array | null> {
    this.calls.read += 1;
    return this.file;
  }

  async row(_org: string, _batch: string, rowNo: number, value: ImportRowValue): Promise<ImportRowOutcome> {
    this.calls.row += 1;
    if (this.failRowFrom !== null && rowNo >= this.failRowFrom) throw new ImportGatewayError("row", this.failKind);
    const known = this.rows.get(rowNo);
    if (known) return known;
    const outcome: ImportRowOutcome = { outcome: "created", reason: null, leadCreated: true };
    this.rows.set(rowNo, outcome);
    this.values.set(rowNo, value);
    return outcome;
  }

  async rowError(_org: string, _batch: string, rowNo: number, reason: string): Promise<void> {
    this.calls.rowError += 1;
    if (!this.errors.has(rowNo)) this.errors.set(rowNo, reason);
  }

  async finish(org: string, batch: string, rows: number): Promise<void> {
    this.finished = { org, batch, rows };
  }

  async fail(_org: string, _batch: string, code: ImportFailCode): Promise<void> {
    if (this.failFail) throw new ImportGatewayError("fail");
    this.failed = code;
  }
}
