import { can } from "@fusion-leap/permissions";
import { BuildingIcon, FolderKanbanIcon, HandshakeIcon, TargetIcon, TrophyIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GettingStarted, type ChecklistStep } from "@/components/dashboard/getting-started";
import { GreetingHeader } from "@/components/dashboard/greeting-header";
import { QuickActions } from "@/components/dashboard/quick-actions";
import { StatCard } from "@/components/dashboard/stat-card";
import { PlanUsageCard } from "@/components/plans/plan-usage-card";
import { requireLocale } from "../../../../i18n/require-locale";
import { requireClaims } from "../../../../lib/auth/require-claims";
import { dayPart, getDashboardCounts } from "../../../../lib/dashboard/queries";
import { getOrganizationUsage } from "../../../../lib/plans/queries";
import { createClient } from "../../../../lib/supabase/server";
import { requireTenantContext } from "../../../../lib/tenant/context";

export const dynamic = "force-dynamic";

export default async function DashboardPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = await requireLocale(params);
  const t = await getTranslations({ locale, namespace: "Dashboard" });
  const to = await getTranslations({ locale, namespace: "Org" });
  // Authentification vérifiée ici ; l'adresse de connexion se lit dans le menu utilisateur.
  await requireClaims(locale);
  // Contexte revérifié en base à chaque requête ; redirige vers onboarding / sélection si besoin.
  const tenant = await requireTenantContext(locale);
  const role = tenant.role;
  // Simples commodités d'affichage : chaque écran, chaque action et la base revérifient les droits.
  const access = {
    projects: can(role, "read", "projects"),
    leads: can(role, "read", "leads"),
    deals: can(role, "read", "deals"),
  };
  const canSeeUsage = can(role, "view", "billing");
  const supabase = await createClient();
  const [counts, usage] = await Promise.all([
    getDashboardCounts(supabase, tenant.organizationId, access),
    canSeeUsage ? getOrganizationUsage(tenant.organizationId) : Promise.resolve([]),
  ]);

  const canCreateProject = can(role, "create", "projects");
  const canCreateLead = can(role, "create", "leads");
  const canConnect = can(role, "connect", "integrations");
  const canListMembers = can(role, "list", "members");
  const used = (metric: string) => usage.find((r) => r.metric === metric)?.used ?? null;

  // Étapes de démarrage : uniquement celles que le rôle peut accomplir et dont l'état est connu.
  const steps: ChecklistStep[] = [];
  if (canCreateProject && counts.projects !== null) steps.push({ key: "project", done: counts.projects > 0, href: "/projects/new" });
  if (canCreateLead && counts.leads !== null) steps.push({ key: "lead", done: counts.leads > 0, href: "/leads" });
  if (canListMembers && used("users") !== null) steps.push({ key: "member", done: (used("users") ?? 0) > 1, href: "/members" });
  if (canConnect && used("integrations") !== null) steps.push({ key: "integration", done: (used("integrations") ?? 0) > 0, href: "/integrations" });

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-6">
      <GreetingHeader locale={locale} timeZone={tenant.organization.timezone} roleLabel={to(`roles.${role}`)}>
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          {t(`greeting.${dayPart(new Date(), tenant.organization.timezone)}`)}, <bdi>{tenant.organization.name}</bdi>
        </h1>
      </GreetingHeader>

      <section aria-label={t("stats.title")} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard locale={locale} icon={FolderKanbanIcon} href="/projects" value={counts.projects} label={t("stats.projects")} hint={t("stats.projectsHint")} />
        <StatCard locale={locale} icon={TargetIcon} href="/leads" value={counts.leads} label={t("stats.leads")} hint={t("stats.leadsHint")} />
        <StatCard locale={locale} icon={HandshakeIcon} href="/deals" value={counts.dealsOpen} label={t("stats.dealsOpen")} hint={t("stats.dealsOpenHint")} />
        <StatCard locale={locale} icon={TrophyIcon} href="/deals" value={counts.dealsWon} label={t("stats.dealsWon")} hint={t("stats.dealsWonHint")} />
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="grid content-start gap-4 lg:col-span-2">
          <PlanUsageCard rows={usage} locale={locale} />
        </div>
        <div className="grid content-start gap-4">
          <GettingStarted locale={locale} steps={steps} />
          <QuickActions
            locale={locale}
            access={{ project: canCreateProject, lead: canCreateLead, integration: canConnect, member: canListMembers }}
          />
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
                <dt className="text-muted-foreground">{t("preferences.language")}</dt>
                <dd className="font-medium">{t(`preferences.languages.${tenant.organization.locale}`)}</dd>
                <dt className="text-muted-foreground">{t("preferences.timezone")}</dt>
                <dd>
                  <bdi dir="ltr" className="font-mono">
                    {tenant.organization.timezone}
                  </bdi>
                </dd>
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
