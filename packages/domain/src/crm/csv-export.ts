import type { LeadListRow } from "./search";

/**
 * Export CSV des leads (J24, spec §11, ADR 014 : owner et admin). Fonctions PURES. Protection contre l'INJECTION DE FORMULE : une
 * cellule qui commence par `=`, `+`, `-`, `@`, une tabulation ou un retour chariot est préfixée d'une apostrophe (OWASP) ; un numéro
 * E.164 (`+` suivi de 6 à 15 chiffres) est une valeur sûre et reste tel quel.
 */
// Revue sécurité : aussi après des espaces ou des caractères invisibles (U+00A0, U+200B…), que certains tableurs ignorent.
const DANGEROUS_START = /^[\s\u00a0\u200b-\u200f\u2060\ufeff]*[=+\-@]|^[\t\r]/;
const E164 = /^\+[0-9]{6,15}$/;

export function neutralizeFormula(value: string): string {
  return DANGEROUS_START.test(value) && !E164.test(value) ? `'${value}` : value;
}

/** Une cellule CSV : formule neutralisée, puis guillemets si nécessaire (séparateur, guillemet, retour à la ligne). */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = neutralizeFormula(String(value));
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const LEADS_EXPORT_HEADER = ["lead_id", "created_at", "name", "email", "phone", "source", "stage", "assignee_id", "project_id"] as const;

export function buildLeadsExportCsv(rows: readonly LeadListRow[]): string {
  const lines = [LEADS_EXPORT_HEADER.join(",")];
  for (const row of rows) {
    lines.push(
      [row.id, row.created_at, row.contact_name, row.contact_email, row.contact_phone, row.source, row.stage_name, row.assignee_id, row.project_id]
        .map(csvCell)
        .join(","),
    );
  }
  // BOM UTF-8 : Excel lit correctement les noms arabes et accentués. Première ligne `sep=,` : indication de séparateur reconnue par
  // Excel, qui sinon coupe selon le séparateur de liste du système (point-virgule en français ou en arabe) et met toute la ligne
  // dans la première cellule. Les lecteurs CSV stricts n'ont qu'à ignorer cette ligne.
  return `\uFEFFsep=,\r\n${lines.join("\r\n")}\r\n`;
}
