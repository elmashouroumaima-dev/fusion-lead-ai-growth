"use client";

import { useLocale, useTranslations } from "next-intl";
import { Link, usePathname } from "../../i18n/navigation";
import { routing } from "../../i18n/routing";

export function LanguageSwitcher() {
  const t = useTranslations("LanguageSwitcher");
  const locale = useLocale();
  const pathname = usePathname();
  const other = routing.locales.find((l) => l !== locale) ?? routing.defaultLocale;

  return (
    <Link
      className="lang-switch"
      href={pathname}
      locale={other}
      hrefLang={other}
      lang={other}
    >
      {t("switchTo")}
    </Link>
  );
}
