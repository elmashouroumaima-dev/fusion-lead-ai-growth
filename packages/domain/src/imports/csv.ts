/**
 * Analyse CSV en continu (J23, RFC 4180) écrite sans dépendance : guillemets doublés, retours à la ligne dans une cellule, CRLF / LF / CR,
 * BOM UTF-8 retiré, lignes vides ignorées. L'analyse s'alimente par morceaux de texte (`push`) et rend les enregistrements COMPLETS au
 * fil de l'eau ; la mémoire utilisée ne dépend pas de la taille du fichier. Fonctions PURES, bornées : aucune entrée ne peut produire
 * une cellule, un enregistrement ou un nombre de colonnes sans limite.
 */

export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 10_000;
export const IMPORT_MAX_COLUMNS = 50;
export const IMPORT_MAX_CELL_LENGTH = 2000;
export const IMPORT_PREVIEW_ROWS = 20;

export type CsvDelimiter = "," | ";" | "\t";

export type CsvErrorCode = "row_too_wide" | "cell_too_long" | "unterminated_quote" | "too_many_rows";

export class CsvError extends Error {
  readonly code: CsvErrorCode;
  constructor(code: CsvErrorCode) {
    super(code);
    this.name = "CsvError";
    this.code = code;
  }
}

/** Délimiteur le plus fréquent (hors guillemets) dans la première ligne ; « , » par défaut. */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts: Record<CsvDelimiter, number> = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  const head = text.charCodeAt(0) === 0xfeff ? text.slice(1, 4096) : text.slice(0, 4096);
  for (const ch of head) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    else if (!inQuotes && ch in counts) counts[ch as CsvDelimiter] += 1;
  }
  let best: CsvDelimiter = ",";
  for (const candidate of [";", "\t"] as const) if (counts[candidate] > counts[best]) best = candidate;
  return best;
}

export class CsvParser {
  private field = "";
  private record: string[] = [];
  private inQuotes = false;
  /** Un guillemet vient d'être lu DANS une cellule entre guillemets : fermeture, ou début d'un guillemet doublé. */
  private quotePending = false;
  /** Cellule commencée par un guillemet (donc pas vide même sans caractère). */
  private quoted = false;
  private skipLf = false;
  private started = false;
  private bomChecked = false;
  private records = 0;

  constructor(
    private readonly delimiter: CsvDelimiter = ",",
    private readonly maxRecords: number = IMPORT_MAX_ROWS + 1,
  ) {}

  /** Nombre d'enregistrements non vides déjà rendus (en-tête compris). */
  get count(): number {
    return this.records;
  }

  push(chunk: string): string[][] {
    const out: string[][] = [];
    let text = chunk;
    if (!this.bomChecked && text.length > 0) {
      this.bomChecked = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i] as string;
      if (this.skipLf) {
        this.skipLf = false;
        if (ch === "\n") continue;
      }
      if (this.quotePending) {
        if (ch === '"') {
          this.append('"');
          this.quotePending = false;
          continue;
        }
        this.inQuotes = false;
        this.quotePending = false;
      }
      if (this.inQuotes) {
        if (ch === '"') this.quotePending = true;
        else this.append(ch);
        continue;
      }
      this.started = true;
      if (ch === '"' && this.field.length === 0 && !this.quoted) {
        this.inQuotes = true;
        this.quoted = true;
      } else if (ch === this.delimiter) {
        this.endField();
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r") this.skipLf = true;
        this.endRecord(out);
      } else {
        this.append(ch);
      }
    }
    return out;
  }

  /** Fin du fichier : rend le dernier enregistrement ; un guillemet ouvert et jamais fermé est une erreur. */
  end(): string[][] {
    const out: string[][] = [];
    if (this.quotePending) {
      this.inQuotes = false;
      this.quotePending = false;
    }
    if (this.inQuotes) throw new CsvError("unterminated_quote");
    if (this.started) this.endRecord(out);
    return out;
  }

  private append(ch: string): void {
    if (this.field.length >= IMPORT_MAX_CELL_LENGTH) throw new CsvError("cell_too_long");
    this.field += ch;
  }

  private endField(): void {
    if (this.record.length >= IMPORT_MAX_COLUMNS) throw new CsvError("row_too_wide");
    this.record.push(this.field);
    this.field = "";
    this.quoted = false;
  }

  private endRecord(out: string[][]): void {
    const blank = this.record.length === 0 && this.field.length === 0 && !this.quoted;
    if (!blank) {
      this.endField();
      if (this.records >= this.maxRecords) throw new CsvError("too_many_rows");
      this.records += 1;
      out.push(this.record);
    }
    this.record = [];
    this.field = "";
    this.quoted = false;
    this.started = false;
  }
}

/** Tout le texte d'un coup (aperçus et tests) : même analyse que le flux. */
export function parseCsv(text: string, delimiter: CsvDelimiter = detectDelimiter(text), maxRecords: number = IMPORT_MAX_ROWS + 1): string[][] {
  const parser = new CsvParser(delimiter, maxRecords);
  return [...parser.push(text), ...parser.end()];
}
