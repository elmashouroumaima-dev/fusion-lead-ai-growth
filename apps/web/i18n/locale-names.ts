import type { AuthLocale } from "@fusion-leap/domain";

/** Nom de chaque langue dans sa propre langue (endonyme) : volontairement non traduit. */
export const LOCALE_NATIVE_NAMES: Record<AuthLocale, string> = {
  fr: "Français",
  ar: "العربية",
  en: "English",
};
