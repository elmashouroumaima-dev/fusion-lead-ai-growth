import { randomUUID } from "node:crypto";
import {
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  IMPORT_PREVIEW_ROWS,
  CsvError,
  importBatchRowSchema,
  importReportRowSchema,
  importRowKeys,
  normalizeImportRow,
  parseCsv,
  type CancelImportInput,
  type ConfirmImportInput,
  type ImportBatchRow,
  type ImportMapping,
  type ImportReason,
  type ImportReportRow,
} from "@fusion-leap/domain";
import { mapLeadsDbError } from "../leads/map-error";
import type { ServiceErrorCode } from "../service/errors";
import type { ServerSupabase } from "../tenant/identity";

/**
 * Import CSV de leads (J23, spec §9.1, plan J23), assistant en 3 étapes : envoi -> mapping + aperçu (SANS rien écrire) ->
 * confirmation (job `import_csv` traité par le worker). Tout passe par le client serveur de l'UTILISATEUR (politiques Storage, RLS,
 * fonctions SQL réservées à owner et admin) : aucune `service_role` ici. L'entreprise vient du CONTEXTE VÉRIFIÉ ; le chemin du fichier
 * est GÉNÉRÉ ici (`{entreprise}/{lot}.csv`), jamais repris du client. Le contenu du fichier n'est jamais journalisé.
 */
export type ImportResult<T> = { ok: true; value: T } | { ok: false; code: ServiceErrorCode };

const BUCKET = "imports";
const fail = (code: ServiceErrorCode): { ok: false; code: ServiceErrorCode } => ({ ok: false, code });

const BATCH_COLUMNS =
  "id, organization_id, project_id, status, file_size, row_count, created_count, matched_count, skipped_count, error_count, error_code, created_at, updated_at, started_at, finished_at";
const REPORT_COLUMNS = "row_no, outcome, reason, lead_created";
/** Taille d'un bloc de lecture du rapport (plafond de réponse de l'API). */
const REPORT_PAGE = 1000;
/** Valeurs envoyées à `import_dedup_check` à chaque appel (plafond de la fonction). */
const DEDUP_CHUNK = 1000;
const PREVIEW_ERRORS_MAX = 100;

function storageFailure(error: { message?: string | undefined; statusCode?: string | number | undefined } | null): ServiceErrorCode {
  const status = String(error?.statusCode ?? "");
  const message = error?.message ?? "";
  if (status === "403" || status === "401" || /row-level security|not allowed|unauthorized/i.test(message)) return "forbidden";
  if (status === "404" || /not found/i.test(message)) return "not_found";
  return "internal_error";
}

/** Octets -> lignes : UTF-8 STRICT (un octet invalide est refusé), analyse bornée ; `null` si le fichier n'est pas un CSV acceptable. */
function decodeCsv(bytes: Uint8Array): string[][] | null {
  if (bytes.byteLength === 0 || bytes.byteLength > IMPORT_MAX_BYTES) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  try {
    return parseCsv(text);
  } catch (error) {
    if (error instanceof CsvError) return null;
    throw error;
  }
}

export type UploadedImport = { batchId: string; rowCount: number; columns: string[] };

/** Étape 1 : vérifie le fichier (taille, encodage, structure), l'envoie au Storage privé, enregistre le lot. */
export async function uploadImport(
  supabase: ServerSupabase,
  organizationId: string,
  input: { projectId: string; bytes: Uint8Array },
): Promise<ImportResult<UploadedImport>> {
  if (input.bytes.byteLength === 0) return fail("validation_failed");
  if (input.bytes.byteLength > IMPORT_MAX_BYTES) return fail("payload_too_large");
  const rows = decodeCsv(input.bytes);
  const header = rows?.[0];
  // un en-tête et au moins une ligne ; le nombre de lignes est borné par l'analyse
  if (!rows || !header || rows.length < 2 || rows.length - 1 > IMPORT_MAX_ROWS) return fail("validation_failed");

  const batchId = randomUUID();
  const path = `${organizationId}/${batchId}.csv`;
  const uploaded = await supabase.storage.from(BUCKET).upload(path, input.bytes, { contentType: "text/csv", upsert: false });
  if (uploaded.error) return fail(storageFailure(uploaded.error));

  let error: { code?: string | null; message?: string | null } | null;
  try {
    ({ error } = await supabase.rpc("create_import_batch", {
      p_org: organizationId,
      p_project: input.projectId,
      p_path: path,
      p_size: input.bytes.byteLength,
    }));
  } catch {
    error = { code: null, message: "transport" };
  }
  if (error) {
    // le lot n'existe pas : le fichier envoyé est retiré (meilleur effort)
    await supabase.storage.from(BUCKET).remove([path]);
    return fail(mapLeadsDbError(error));
  }
  return { ok: true, value: { batchId, rowCount: rows.length - 1, columns: header.slice(0, 50) } };
}

export type PreviewRowStatus = "new" | "existing" | "duplicate_in_file" | "error";
export type ImportPreview = {
  rowCount: number;
  valid: number;
  newContacts: number;
  existingContacts: number;
  duplicatesInFile: number;
  errors: number;
  errorsByReason: Partial<Record<ImportReason, number>>;
  /** 100 premières erreurs : numéro de ligne et motif (aucune valeur). */
  errorRows: Array<{ rowNo: number; reason: ImportReason }>;
  /** Les 20 premières lignes : cellules lues et statut ; réservé à owner et admin. */
  rows: Array<{ rowNo: number; cells: string[]; status: PreviewRowStatus; reason: ImportReason | null }>;
};

async function loadBatch(supabase: ServerSupabase, organizationId: string, batchId: string): Promise<ImportBatchRow | null> {
  const { data, error } = await supabase
    .from("import_batches")
    .select(BATCH_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("id", batchId)
    .maybeSingle();
  if (error) throw new Error("import_lookup_failed");
  if (!data) return null;
  const parsed = importBatchRowSchema.safeParse(data);
  if (!parsed.success) throw new Error("rows_unreadable");
  return parsed.data;
}

async function dedupExisting(
  supabase: ServerSupabase,
  organizationId: string,
  emails: string[],
  phones: string[],
): Promise<{ emails: Set<string>; phones: Set<string> } | null> {
  const foundEmails = new Set<string>();
  const foundPhones = new Set<string>();
  const chunks = Math.max(Math.ceil(emails.length / DEDUP_CHUNK), Math.ceil(phones.length / DEDUP_CHUNK));
  for (let i = 0; i < chunks; i += 1) {
    const { data, error } = await supabase.rpc("import_dedup_check", {
      p_org: organizationId,
      p_emails: emails.slice(i * DEDUP_CHUNK, (i + 1) * DEDUP_CHUNK),
      p_phones: phones.slice(i * DEDUP_CHUNK, (i + 1) * DEDUP_CHUNK),
    });
    if (error || typeof data !== "object" || data === null) return null;
    const result = data as { emails?: unknown; phones?: unknown };
    if (!Array.isArray(result.emails) || !Array.isArray(result.phones)) return null;
    for (const email of result.emails) if (typeof email === "string") foundEmails.add(email);
    for (const phone of result.phones) if (typeof phone === "string") foundPhones.add(phone);
  }
  return { emails: foundEmails, phones: foundPhones };
}

/**
 * Étape 2 : mapping des colonnes + aperçu + rapport de déduplication, SANS RIEN ÉCRIRE (ni contact, ni lead, ni consentement). Les
 * lignes sont normalisées avec les mêmes règles que les contacts saisis ; les e-mails et téléphones valides sont comparés aux
 * contacts de l'entreprise par `import_dedup_check` (lecture seule).
 */
export async function previewImport(
  supabase: ServerSupabase,
  organizationId: string,
  input: Pick<ConfirmImportInput, "batch_id" | "mapping" | "default_country">,
): Promise<ImportResult<ImportPreview>> {
  let batch: ImportBatchRow | null;
  try {
    batch = await loadBatch(supabase, organizationId, input.batch_id);
  } catch {
    return fail("internal_error");
  }
  if (!batch) return fail("not_found");
  if (batch.status !== "uploaded") return fail("conflict");

  const downloaded = await supabase.storage.from(BUCKET).download(`${organizationId}/${input.batch_id}.csv`);
  if (downloaded.error || !downloaded.data) return fail(storageFailure(downloaded.error));
  const rows = decodeCsv(new Uint8Array(await downloaded.data.arrayBuffer()));
  if (!rows || rows.length < 2) return fail("validation_failed");

  const mapping: ImportMapping = input.mapping;
  const evaluated = rows.slice(1).map((cells, index) => ({
    rowNo: index + 2,
    cells,
    result: normalizeImportRow(cells, mapping, input.default_country),
  }));
  const emails = new Set<string>();
  const phones = new Set<string>();
  for (const row of evaluated) {
    if (!row.result.ok) continue;
    if (row.result.value.email_normalized) emails.add(row.result.value.email_normalized);
    if (row.result.value.phone_e164) phones.add(row.result.value.phone_e164);
  }
  const existing = await dedupExisting(supabase, organizationId, [...emails], [...phones]);
  if (!existing) return fail("internal_error");

  const seen = new Set<string>();
  const preview: ImportPreview = {
    rowCount: evaluated.length,
    valid: 0,
    newContacts: 0,
    existingContacts: 0,
    duplicatesInFile: 0,
    errors: 0,
    errorsByReason: {},
    errorRows: [],
    rows: [],
  };
  for (const row of evaluated) {
    let status: PreviewRowStatus;
    let reason: ImportReason | null = null;
    if (!row.result.ok) {
      status = "error";
      reason = row.result.reason;
      preview.errors += 1;
      preview.errorsByReason[reason] = (preview.errorsByReason[reason] ?? 0) + 1;
      if (preview.errorRows.length < PREVIEW_ERRORS_MAX) preview.errorRows.push({ rowNo: row.rowNo, reason });
    } else {
      preview.valid += 1;
      const keys = importRowKeys(row.result.value);
      const repeated = keys.some((key) => seen.has(key));
      for (const key of keys) seen.add(key);
      const known =
        (row.result.value.email_normalized !== null && existing.emails.has(row.result.value.email_normalized)) ||
        (row.result.value.phone_e164 !== null && existing.phones.has(row.result.value.phone_e164));
      if (repeated) {
        status = "duplicate_in_file";
        reason = "duplicate_in_file";
        preview.duplicatesInFile += 1;
      } else if (known) {
        status = "existing";
        preview.existingContacts += 1;
      } else {
        status = "new";
        preview.newContacts += 1;
      }
    }
    if (preview.rows.length < IMPORT_PREVIEW_ROWS) preview.rows.push({ rowNo: row.rowNo, cells: row.cells, status, reason });
  }
  return { ok: true, value: preview };
}

/**
 * Étape 3 : confirme le lot (mapping + pays par défaut) ; la base enfile le job `import_csv`. Le fichier est relu pour compter ses
 * lignes (indicatif) et vérifier qu'il reste un CSV acceptable. Rien d'autre n'est écrit ici.
 */
export async function confirmImport(supabase: ServerSupabase, organizationId: string, input: ConfirmImportInput): Promise<ImportResult<true>> {
  let batch: ImportBatchRow | null;
  try {
    batch = await loadBatch(supabase, organizationId, input.batch_id);
  } catch {
    return fail("internal_error");
  }
  if (!batch) return fail("not_found");
  // lot déjà confirmé, annulé ou terminé : conflit (avant toute lecture du fichier, qui peut avoir été retiré)
  if (batch.status !== "uploaded") return fail("conflict");
  const downloaded = await supabase.storage.from(BUCKET).download(`${organizationId}/${input.batch_id}.csv`);
  if (downloaded.error || !downloaded.data) return fail(storageFailure(downloaded.error));
  const rows = decodeCsv(new Uint8Array(await downloaded.data.arrayBuffer()));
  if (!rows || rows.length < 2 || rows.length - 1 > IMPORT_MAX_ROWS) return fail("validation_failed");
  const { error } = await supabase.rpc("confirm_import", {
    p_org: organizationId,
    p_batch: input.batch_id,
    p_mapping: input.mapping,
    p_default_country: input.default_country,
    p_rows: rows.length - 1,
  });
  return error ? fail(mapLeadsDbError(error)) : { ok: true, value: true };
}

export async function cancelImport(supabase: ServerSupabase, organizationId: string, input: CancelImportInput): Promise<ImportResult<true>> {
  const { error } = await supabase.rpc("cancel_import", { p_org: organizationId, p_batch: input.batch_id });
  if (error) return fail(mapLeadsDbError(error));
  // le fichier (données personnelles) n'a plus d'usage : retiré (meilleur effort ; une purge planifiée reste à prévoir)
  await supabase.storage.from(BUCKET).remove([`${organizationId}/${input.batch_id}.csv`]);
  return { ok: true, value: true };
}

export async function getImportBatch(supabase: ServerSupabase, organizationId: string, batchId: string): Promise<ImportBatchRow | null> {
  return loadBatch(supabase, organizationId, batchId);
}

export async function listImportBatches(supabase: ServerSupabase, organizationId: string, limit = 50): Promise<ImportBatchRow[]> {
  const { data, error } = await supabase
    .from("import_batches")
    .select(BATCH_COLUMNS)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(0, Math.min(Math.max(limit, 1), 200) - 1);
  if (error || !Array.isArray(data)) throw new Error("imports_lookup_failed");
  return data.map((row: unknown) => {
    const parsed = importBatchRowSchema.safeParse(row);
    if (!parsed.success) throw new Error("rows_unreadable");
    return parsed.data;
  });
}

/** Rapport d'un lot terminé (ou en cours) : une ligne par ligne du fichier traitée ; codes seulement, jamais de donnée de contact. */
export async function getImportReport(
  supabase: ServerSupabase,
  organizationId: string,
  batchId: string,
): Promise<{ batch: ImportBatchRow; rows: ImportReportRow[] } | null> {
  const batch = await loadBatch(supabase, organizationId, batchId);
  if (!batch) return null;
  // Revue sécurité : l'API plafonne chaque réponse (1000 lignes) ; le rapport se lit par blocs, dans l'ordre des lignes.
  const rows: ImportReportRow[] = [];
  for (let from = 0; from <= IMPORT_MAX_ROWS; from += REPORT_PAGE) {
    const { data, error } = await supabase
      .from("import_rows")
      .select(REPORT_COLUMNS)
      .eq("organization_id", organizationId)
      .eq("batch_id", batchId)
      .order("row_no", { ascending: true })
      .range(from, from + REPORT_PAGE - 1);
    if (error || !Array.isArray(data)) throw new Error("import_report_lookup_failed");
    for (const row of data) {
      const parsed = importReportRowSchema.safeParse(row);
      if (!parsed.success) throw new Error("rows_unreadable");
      rows.push(parsed.data);
    }
    if (data.length < REPORT_PAGE) break;
  }
  return { batch, rows };
}
