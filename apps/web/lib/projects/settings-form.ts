import type { ProjectType } from "@fusion-leap/domain";

/**
 * Passage entre les champs de l'interface et l'objet `settings` d'un projet (J16, spec §4). Fonctions pures (testées) :
 * les listes se saisissent « une ligne par élément » ; les lignes et champs vides disparaissent (zod refuse un texte vide).
 * La forme finale est TOUJOURS revalidée par zod côté serveur : ceci n'est qu'une commodité de saisie.
 */

export type SettingsValue = Record<string, unknown>;

/** Texte multiligne -> liste (lignes rognées, vides retirées). */
export function linesToList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Liste -> texte multiligne. */
export function listToLines(value: unknown): string {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").join("\n") : "";
}

const LIST_KEYS: Record<ProjectType, readonly string[]> = {
  website_sales: ["offers", "business_models", "qualification_questions"],
  salla_app: ["merchant_segments"],
  salla_theme: ["sectors", "features", "ad_scenarios"],
  custom: [],
};
const TEXT_KEYS: Record<ProjectType, readonly string[]> = {
  website_sales: ["target_market"],
  salla_app: ["app_name", "problem_solved", "store_url", "activation_flow", "test_pricing"],
  salla_theme: ["preview_url"],
  custom: ["notes"],
};

const trimmed = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

type Row = Record<string, unknown>;
const rowsOf = (value: unknown): Row[] => (Array.isArray(value) ? value.filter((row): row is Row => typeof row === "object" && row !== null) : []);

/**
 * Nettoie l'état du formulaire avant l'envoi : textes rognés, listes sans ligne vide, lignes de tableau incomplètes
 * retirées (une ligne à moitié remplie reste, zod la refusera avec un message), clés vides supprimées.
 */
export function cleanSettings(type: ProjectType, raw: SettingsValue): SettingsValue {
  const out: SettingsValue = {};
  for (const key of TEXT_KEYS[type]) {
    const text = trimmed(raw[key]);
    if (text) out[key] = text;
  }
  for (const key of LIST_KEYS[type]) {
    // Pendant la saisie, une liste est un TEXTE multiligne (on peut taper un saut de ligne) ; une liste déjà formée est acceptée aussi.
    const value = raw[key];
    const list = typeof value === "string" ? linesToList(value) : Array.isArray(value) ? value.map(trimmed).filter(Boolean) : [];
    if (list.length > 0) out[key] = list;
  }
  if (type === "website_sales") {
    const pages = rowsOf(raw.landing_pages)
      .map((row) => ({ name: trimmed(row.name), url: trimmed(row.url) }))
      .filter((row) => row.name || row.url);
    if (pages.length > 0) out.landing_pages = pages;
  }
  if (type === "salla_app") {
    const faqs = rowsOf(raw.faqs)
      .map((row) => ({ question: trimmed(row.question), answer: trimmed(row.answer) }))
      .filter((row) => row.question || row.answer);
    if (faqs.length > 0) out.faqs = faqs;
  }
  if (type === "custom") {
    const fields: Record<string, string> = {};
    for (const row of rowsOf(raw.fields_rows)) {
      const key = trimmed(row.key);
      const value = trimmed(row.value);
      if (key || value) fields[key] = value;
    }
    if (Object.keys(fields).length > 0) out.fields = fields;
  }
  return out;
}

/**
 * Réglages enregistrés -> état du formulaire : les listes deviennent du texte multiligne (une ligne par élément) et le
 * champ `fields` de « custom » devient des lignes clé / valeur.
 */
export function settingsToFormState(type: ProjectType, settings: SettingsValue): SettingsValue {
  const state: SettingsValue = { ...settings };
  for (const key of LIST_KEYS[type]) {
    if (Array.isArray(state[key])) state[key] = listToLines(state[key]);
  }
  if (type !== "custom") return state;
  const fields = settings.fields;
  delete state.fields;
  state.fields_rows =
    typeof fields === "object" && fields !== null && !Array.isArray(fields)
      ? Object.entries(fields as Record<string, unknown>).map(([key, value]) => ({ key, value: typeof value === "string" ? value : "" }))
      : [];
  return state;
}
