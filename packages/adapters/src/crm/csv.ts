import { csvCell, detectDelimiter, parseCsv, type CrmMappingEntry } from "@fusion-leap/domain";
import type { CrmAdapter, CrmAdapterResult, CrmReceiveResult, CrmRecord, CrmRejection, CrmSendResult } from "./types";

/**
 * Adaptateur `csv` : le « fournisseur » est un fichier. `receive` lit un CSV selon le mapping (`external_field` = en-tête de colonne,
 * `internal_field` = champ interne) ; `send` produit un CSV avec les mêmes colonnes, cellules protégées contre l'injection de formule.
 * Pur : ne lit ni n'écrit de fichier lui-même (l'appelant fournit le texte et reçoit la charge utile).
 */
/** ISO 8601 strict (date, ou date et heure avec fuseau facultatif) : « 01/02/2026 » ou « 5 » sont ambigus et refusés. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export class CsvCrmAdapter implements CrmAdapter {
  readonly provider = "csv" as const;
  private readonly mappings: readonly CrmMappingEntry[];

  constructor(mappings: readonly CrmMappingEntry[]) {
    this.mappings = mappings.filter((entry) => entry.entity === "contact");
  }

  async connect(): Promise<CrmAdapterResult> {
    return { ok: true };
  }

  /** Le mapping doit désigner une colonne d'identifiant stable. */
  async validate(): Promise<CrmAdapterResult> {
    return this.mappings.some((entry) => entry.internal_field === "external_id") ? { ok: true } : { ok: false, code: "invalid_mapping" };
  }

  async receive(input: { text: string }): Promise<CrmReceiveResult> {
    const rows = parseCsv(input.text, detectDelimiter(input.text));
    const header = rows[0] ?? [];
    const columnOf = new Map<string, number>();
    header.forEach((name, index) => {
      if (!columnOf.has(name.trim())) columnOf.set(name.trim(), index);
    });
    const records: CrmRecord[] = [];
    const rejected: CrmRejection[] = [];
    const missingColumns = this.mappings.filter((entry) => !columnOf.has(entry.external_field)).map((entry) => entry.external_field);
    for (let index = 1; index < rows.length; index += 1) {
      const cells = rows[index] as string[];
      const rowNo = index + 1;
      const fields: Record<string, string | null> = {};
      let externalId = "";
      let updatedAt: Date | null = null;
      let bad: CrmRejection["reason"] | null = null;
      for (const entry of this.mappings) {
        const column = columnOf.get(entry.external_field);
        if (column === undefined) continue;
        const value = (cells[column] ?? "").trim();
        if (entry.internal_field === "external_id") externalId = value;
        else if (entry.internal_field === "external_updated_at") {
          if (value.length > 0) {
            const date = ISO_DATE.test(value) ? new Date(value.replace(" ", "T")) : null;
            if (date === null || Number.isNaN(date.getTime())) bad = "invalid_date";
            else updatedAt = date;
          }
        } else if (entry.direction !== "push") {
          fields[entry.internal_field] = value.length > 0 ? value : null;
        }
      }
      if (bad) rejected.push({ rowNo, reason: bad });
      else if (externalId.length === 0) rejected.push({ rowNo, reason: "no_external_id" });
      else records.push({ entity: "contact", externalId, fields, updatedAt });
    }
    return { records, rejected, missingColumns };
  }

  async send(records: readonly CrmRecord[]): Promise<CrmSendResult> {
    // colonnes poussables : sens `push` ou `both` ; l'identifiant externe est toujours écrit
    const columns = this.mappings.filter((entry) => entry.internal_field === "external_id" || entry.direction !== "pull");
    const lines = [columns.map((entry) => csvCell(entry.external_field)).join(",")];
    for (const record of records) {
      lines.push(
        columns.map((entry) => csvCell(entry.internal_field === "external_id" ? record.externalId : record.fields[entry.internal_field] ?? null)).join(","),
      );
    }
    return { accepted: records.length, skipped: 0, payload: `${lines.join("\r\n")}\r\n` };
  }

  async refresh(): Promise<CrmAdapterResult> {
    return { ok: true };
  }
  async disconnect(): Promise<void> {}
}
