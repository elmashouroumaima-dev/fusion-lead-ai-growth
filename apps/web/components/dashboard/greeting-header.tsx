import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import type { AuthLocale } from "@fusion-leap/domain";
import type { ReactNode } from "react";

/** En-tête d'accueil : salutation selon l'heure locale de l'organisation, date longue dans la langue active, rôle. */
export async function GreetingHeader({
  locale,
  timeZone,
  roleLabel,
  now = new Date(),
  children,
}: {
  locale: AuthLocale;
  timeZone: string;
  roleLabel: string;
  now?: Date;
  /** Le titre de niveau 1 (rendu par la page : un seul <h1> par page). */
  children: ReactNode;
}) {
  const t = await getTranslations({ locale, namespace: "Dashboard" });
  let date: string;
  try {
    date = new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone }).format(now);
  } catch {
    date = new Intl.DateTimeFormat(locale, { dateStyle: "full" }).format(now);
  }
  return (
    <header className="from-brand/15 via-brand/5 relative overflow-hidden rounded-2xl border bg-linear-to-b to-transparent p-6">
      <span aria-hidden="true" className="bg-brand/15 pointer-events-none absolute -end-10 -top-10 size-40 rounded-full blur-2xl" />
      <div className="relative grid gap-2">
        <p className="text-muted-foreground text-sm">{date}</p>
        {children}
        <p className="text-muted-foreground max-w-2xl text-sm">{t("subtitle")}</p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Badge variant="secondary">
            <span className="sr-only">{t("role.title")} : </span>
            {roleLabel}
          </Badge>
        </div>
      </div>
    </header>
  );
}
