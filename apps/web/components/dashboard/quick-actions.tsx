import { FolderPlusIcon, PlugIcon, TargetIcon, UserPlusIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { AuthLocale } from "@fusion-leap/domain";
import { Link } from "../../i18n/navigation";

export type QuickActionsAccess = { project: boolean; lead: boolean; integration: boolean; member: boolean };

/** Raccourcis : seulement ceux que le rôle peut utiliser (confort d'affichage ; chaque écran et la base revérifient). */
export async function QuickActions({ locale, access }: { locale: AuthLocale; access: QuickActionsAccess }) {
  const t = await getTranslations({ locale, namespace: "Dashboard" });
  const actions = [
    { show: access.project, href: "/projects/new", icon: FolderPlusIcon, label: t("quick.project") },
    { show: access.lead, href: "/leads", icon: TargetIcon, label: t("quick.lead") },
    { show: access.member, href: "/members", icon: UserPlusIcon, label: t("quick.member") },
    { show: access.integration, href: "/integrations", icon: PlugIcon, label: t("quick.integration") },
  ].filter((a) => a.show);
  if (actions.length === 0) return null;
  return (
    <Card role="region" aria-labelledby="dash-quick-title">
      <CardHeader>
        <CardTitle id="dash-quick-title">
          <h2>{t("quick.title")}</h2>
        </CardTitle>
        <CardDescription>{t("quick.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2 sm:grid-cols-2">
          {actions.map(({ href, icon: Icon, label }) => (
            <li key={href}>
              <Link
                href={href}
                className="text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring flex items-center gap-3 rounded-lg border p-3 text-sm font-medium transition focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none"
              >
                <span className="bg-brand/15 text-primary-text grid size-8 place-items-center rounded-md">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
