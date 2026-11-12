import { can } from "@fusion-leap/permissions";
import { BuildingIcon, GlobeIcon, RocketIcon, ShieldCheckIcon, UsersIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PlanUsageCard } from "@/components/plans/plan-usage-card";
import { Link } from "../../../../i18n/navigation";
import { requireLocale } from "../../../../i18n/require-locale";
import { requireClaims } from "../../../../lib/auth/require-claims";
import { getOrganizationUsage } from "../../../../lib/plans/queries";
import { requireTenantContext } from "../../../../lib/tenant/context";

export const dynamic = "force-dynamic";

export default async function DashboardPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = await requireLocale(params);
  const t = await getTranslations({ locale, namespace: "Dashboard" });
  const to = await getTranslations({ locale, namespace: "Org" });
  const claims = await requireClaims(locale);
  // Contexte revérifié en base à chaque requête ; redirige vers onboarding / sélection si besoin.
  const tenant = await requireTenantContext(locale);
  const email = typeof claims.email === "string" ? claims.email : null;
  // Simple commodité d'affichage : la page Membres et ses actions revérifient tout.
  const canListMembers = can(tenant.role, "list", "members");
  const language = tenant.organization.locale;
  // Utilisation du plan : owner / admin (ADR 014 « Plan / facturation » : voir). La base refuse les autres rôles.
  const usage = can(tenant.role, "view", "billing") ? await getOrganizationUsage(tenant.organizationId) : [];

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6">
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground text-sm">{t("subtitle")}</p>
        <p className="text-muted-foreground text-sm">
          {t("signedInAs")} <bdi dir="ltr">{email ?? t("unknownUser")}</bdi>
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <PlanUsageCard rows={usage} locale={locale} />
        <Card role="region" aria-labelledby="dash-org-title">
          <CardHeader>
            <CardTitle id="dash-org-title" className="flex items-center gap-2">
              <BuildingIcon className="text-primary-text size-4" aria-hidden="true" />
              <h2>{t("organization.title")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t("organization.name")}</dt>
              <dd className="font-medium">
                <bdi>{tenant.organization.name}</bdi>
              </dd>
              <dt className="text-muted-foreground">{t("organization.slug")}</dt>
              <dd>
                <bdi dir="ltr" className="font-mono">
                  {tenant.organization.slug}
                </bdi>
              </dd>
            </dl>
          </CardContent>
        </Card>

        <Card role="region" aria-labelledby="dash-role-title">
          <CardHeader>
            <CardTitle id="dash-role-title" className="flex items-center gap-2">
              <ShieldCheckIcon className="text-primary-text size-4" aria-hidden="true" />
              <h2>{t("role.title")}</h2>
            </CardTitle>
            <CardDescription>{t("role.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <span className="sr-only">{to("dashboard.role")} : </span>
            <Badge variant="secondary">{to(`roles.${tenant.role}`)}</Badge>
          </CardContent>
        </Card>

        <Card role="region" aria-labelledby="dash-prefs-title">
          <CardHeader>
            <CardTitle id="dash-prefs-title" className="flex items-center gap-2">
              <GlobeIcon className="text-primary-text size-4" aria-hidden="true" />
              <h2>{t("preferences.title")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t("preferences.language")}</dt>
              <dd className="font-medium">{t(`preferences.languages.${language}`)}</dd>
              <dt className="text-muted-foreground">{t("preferences.timezone")}</dt>
              <dd>
                <bdi dir="ltr" className="font-mono">
                  {tenant.organization.timezone}
                </bdi>
              </dd>
            </dl>
          </CardContent>
        </Card>

        <Card role="region" aria-labelledby="dash-start-title">
          <CardHeader>
            <CardTitle id="dash-start-title" className="flex items-center gap-2">
              <RocketIcon className="text-primary-text size-4" aria-hidden="true" />
              <h2>{t("start.title")}</h2>
            </CardTitle>
            <CardDescription>{t("start.description")}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {canListMembers ? (
              <>
                <p className="text-muted-foreground text-sm">{t("start.membersHint")}</p>
                <Link href="/members" className={buttonVariants({ variant: "outline", className: "w-fit" })}>
                  <UsersIcon aria-hidden="true" />
                  {t("start.members")}
                </Link>
              </>
            ) : (
              <p className="text-muted-foreground text-sm">{t("start.noMembers")}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
