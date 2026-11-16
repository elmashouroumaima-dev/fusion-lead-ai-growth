import type { ImportField } from "@fusion-leap/domain";

/**
 * Proposition de correspondance colonnes -> champs à partir des EN-TÊTES du fichier (J39c). Pure et sans effet : le résultat n'est qu'une
 * valeur de départ que la personne vérifie et corrige à l'écran ; rien n'est écrit avant la confirmation. Chaque champ prend au plus une
 * colonne et chaque colonne sert au plus un champ (le serveur refuse deux champs sur la même colonne).
 */
export type GuessedMapping = Partial<Record<ImportField, number>>;

const HINTS: Record<ImportField, readonly string[]> = {
  email: ["email", "emailaddress", "mail", "courriel", "adresseemail", "adressemail", "ايميل", "البريد", "البريدالالكتروني", "بريد"],
  phone: ["phone", "telephone", "tel", "mobile", "gsm", "whatsapp", "portable", "numero", "numerodetelephone", "الهاتف", "هاتف", "جوال", "الجوال"],
  name: ["name", "nom", "fullname", "nomcomplet", "contact", "prenomnom", "nomprenom", "الاسم", "اسم"],
  language: ["language", "langue", "lang", "اللغة", "لغة"],
  country: ["country", "pays", "countrycode", "codepays", "الدولة", "دولة", "البلد"],
};

/** Minuscules, sans accents ni ponctuation ni espaces : « E-mail », « e mail » et « Téléphone » se comparent sans bruit. */
export function normalizeHeader(header: string): string {
  return header
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

export function guessMapping(headers: readonly string[]): GuessedMapping {
  const normalized = headers.map(normalizeHeader);
  const mapping: GuessedMapping = {};
  const used = new Set<number>();
  // l'identifiant d'abord (e-mail, téléphone), puis le reste : « numero » ne doit pas voler la colonne du nom
  for (const field of ["email", "phone", "name", "language", "country"] as const) {
    const index = normalized.findIndex((header, i) => !used.has(i) && HINTS[field].includes(header));
    if (index >= 0) {
      mapping[field] = index;
      used.add(index);
    }
  }
  return mapping;
}
