"use client";

import { GlobeIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { LOCALE_NATIVE_NAMES } from "../../i18n/locale-names";
import { Link, usePathname } from "../../i18n/navigation";
import { routing } from "../../i18n/routing";

/** Propose les autres locales, chacune nommée dans sa propre langue (lang/hrefLang corrects). */
export function LanguageSwitcher() {
  const t = useTranslations("LanguageSwitcher");
  const locale = useLocale();
  const pathname = usePathname();
  const others = routing.locales.filter((l) => l !== locale);
  const current = LOCALE_NATIVE_NAMES[routing.locales.find((l) => l === locale) ?? routing.defaultLocale];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={t("label")}>
          <GlobeIcon aria-hidden="true" />
          <span className="hidden sm:inline">{current}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {others.map((other) => (
          <DropdownMenuItem key={other} asChild>
            <Link href={pathname} locale={other} hrefLang={other} lang={other}>
              {LOCALE_NATIVE_NAMES[other]}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
