"use client";

import { useLocale, useTranslations } from "next-intl";
import { Link, usePathname } from "../../i18n/navigation";
import { LOCALE_NATIVE_NAMES } from "../../i18n/locale-names";
import { routing } from "../../i18n/routing";

/** Propose les autres locales, chacune nommée dans sa propre langue (lang/hrefLang corrects). */
export function LanguageSwitcher() {
  const t = useTranslations("LanguageSwitcher");
  const locale = useLocale();
  const pathname = usePathname();
  const others = routing.locales.filter((l) => l !== locale);

  return (
    <nav aria-label={t("label")} className="lang-switcher">
      {others.map((other) => (
        <Link
          key={other}
          className="lang-switch"
          href={pathname}
          locale={other}
          hrefLang={other}
          lang={other}
        >
          {LOCALE_NATIVE_NAMES[other]}
        </Link>
      ))}
    </nav>
  );
}
