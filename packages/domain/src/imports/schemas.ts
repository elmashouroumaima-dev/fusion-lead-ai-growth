import { z } from "zod";
import { CONTACT_NAME_MAX, normalizeContactEmail, normalizePhone } from "../contacts";
import { isSafeText } from "../projects/text";
import { uuidSchema } from "../tenant/schemas";
import { IMPORT_MAX_COLUMNS } from "./csv";

/** Champs d'une ligne importée (contact + lead) ; la colonne est désignée par son rang dans le fichier (à partir de 0). */
export const IMPORT_FIELDS = ["name", "email", "phone", "language", "country"] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

const columnIndex = z.number().int().min(0).max(IMPORT_MAX_COLUMNS - 1);

/** Mapping colonnes -> champs : au moins l'e-mail ou le téléphone ; deux champs ne partagent pas une colonne. */
export const importMappingSchema = z
  .object({
    name: columnIndex.optional(),
    email: columnIndex.optional(),
    phone: columnIndex.optional(),
    language: columnIndex.optional(),
    country: columnIndex.optional(),
  })
  .strict()
  .refine((mapping) => mapping.email !== undefined || mapping.phone !== undefined, { message: "identifier_column_required" })
  .refine((mapping) => {
    const columns = Object.values(mapping).filter((value): value is number => typeof value === "number");
    return new Set(columns).size === columns.length;
  }, { message: "duplicate_column" });
export type ImportMapping = z.infer<typeof importMappingSchema>;

const countryCode = z.string().regex(/^[A-Z]{2}$/);

/** Confirmation : l'entreprise vient du contexte, jamais du corps (champ inconnu = refus). */
export const confirmImportSchema = z
  .object({
    batch_id: uuidSchema,
    mapping: importMappingSchema,
    default_country: countryCode.nullish().transform((value) => value ?? null),
  })
  .strict();
export type ConfirmImportInput = z.output<typeof confirmImportSchema>;

export const cancelImportSchema = z.object({ batch_id: uuidSchema }).strict();
export type CancelImportInput = z.infer<typeof cancelImportSchema>;

/** Résultats par ligne (rapport) : jamais de donnée de contact, seulement un code. */
export const IMPORT_OUTCOMES = ["created", "matched", "skipped", "error"] as const;
export type ImportOutcome = (typeof IMPORT_OUTCOMES)[number];
export const IMPORT_REASONS = [
  "no_identifier",
  "invalid_email",
  "invalid_phone",
  "invalid_name",
  "invalid_language",
  "invalid_country",
  "duplicate_in_file",
  "do_not_contact",
  "quota_exceeded",
  "too_many_leads",
  "failed",
] as const;
export type ImportReason = (typeof IMPORT_REASONS)[number];

export type ImportRowValue = {
  name: string | null;
  email_raw: string | null;
  email_normalized: string | null;
  phone_e164: string | null;
  language: string | null;
  country: string | null;
};

export type ImportRowResult = { ok: true; value: ImportRowValue } | { ok: false; reason: ImportReason };

function cell(cells: readonly string[], index: number | undefined): string | null {
  if (index === undefined) return null;
  const text = (cells[index] ?? "").trim();
  return text.length === 0 ? null : text;
}

/**
 * Ligne du fichier -> valeurs normalisées avec les MÊMES règles que les contacts saisis à la main (J18) : e-mail ASCII en minuscules,
 * téléphone E.164 (le pays par défaut lit un numéro national). Une valeur renseignée mais invalide refuse la ligne (jamais corrigée
 * en silence) ; ni e-mail ni téléphone : refusée.
 */
export function normalizeImportRow(cells: readonly string[], mapping: ImportMapping, defaultCountry: string | null): ImportRowResult {
  const name = cell(cells, mapping.name);
  const email = cell(cells, mapping.email);
  const phone = cell(cells, mapping.phone);
  const language = cell(cells, mapping.language);
  const country = cell(cells, mapping.country);

  if (name !== null && !isSafeText(name, 1, CONTACT_NAME_MAX)) return { ok: false, reason: "invalid_name" };
  let emailNormalized: string | null = null;
  if (email !== null) {
    const parsed = normalizeContactEmail(email);
    if (!parsed.ok) return { ok: false, reason: "invalid_email" };
    emailNormalized = parsed.value;
  }
  let phoneE164: string | null = null;
  if (phone !== null) {
    const parsed = normalizePhone(phone, defaultCountry ?? undefined);
    if (!parsed.ok) return { ok: false, reason: "invalid_phone" };
    phoneE164 = parsed.value;
  }
  if (emailNormalized === null && phoneE164 === null) return { ok: false, reason: "no_identifier" };
  const lang = language === null ? null : language.toLowerCase();
  if (lang !== null && !/^[a-z]{2}$/.test(lang)) return { ok: false, reason: "invalid_language" };
  const ctry = country === null ? null : country.toUpperCase();
  if (ctry !== null && !/^[A-Z]{2}$/.test(ctry)) return { ok: false, reason: "invalid_country" };
  return {
    ok: true,
    value: { name, email_raw: email, email_normalized: emailNormalized, phone_e164: phoneE164, language: lang, country: ctry },
  };
}

/** Clé de dédoublonnage DANS le fichier : e-mail normalisé d'abord, sinon téléphone. */
export function importRowKeys(value: ImportRowValue): string[] {
  const keys: string[] = [];
  if (value.email_normalized) keys.push(`e:${value.email_normalized}`);
  if (value.phone_e164) keys.push(`p:${value.phone_e164}`);
  return keys;
}

/** Lignes de rapport lisibles par owner / admin. */
export const importBatchRowSchema = z.object({
  id: uuidSchema,
  organization_id: uuidSchema,
  project_id: uuidSchema,
  status: z.enum(["uploaded", "queued", "running", "done", "failed", "cancelled"]),
  file_size: z.number().int(),
  row_count: z.number().int().nullable(),
  created_count: z.number().int(),
  matched_count: z.number().int(),
  skipped_count: z.number().int(),
  error_count: z.number().int(),
  error_code: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
});
export type ImportBatchRow = z.infer<typeof importBatchRowSchema>;

export const importReportRowSchema = z.object({
  row_no: z.number().int(),
  outcome: z.enum(IMPORT_OUTCOMES),
  reason: z.enum(IMPORT_REASONS).nullable(),
  lead_created: z.boolean(),
});
export type ImportReportRow = z.infer<typeof importReportRowSchema>;

/** Rapport téléchargeable : CSV sans aucune donnée de contact (numéro de ligne, résultat, motif). */
export function buildImportReportCsv(rows: readonly ImportReportRow[]): string {
  const lines = ["row,outcome,reason,lead_created"];
  for (const row of rows) lines.push(`${row.row_no},${row.outcome},${row.reason ?? ""},${row.lead_created ? "yes" : "no"}`);
  return `${lines.join("\r\n")}\r\n`;
}
