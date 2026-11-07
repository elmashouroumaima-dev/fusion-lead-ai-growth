import { DEFAULT_LOCALE, LOCALES } from "@fusion-leap/domain";
import { defineRouting } from "next-intl/routing";

/** Locales et défaut dérivés de @fusion-leap/domain (source unique, ADR 011 amendé). */
export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: "always",
});
