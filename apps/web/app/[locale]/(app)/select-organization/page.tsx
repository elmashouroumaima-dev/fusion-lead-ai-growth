import { getTranslations } from "next-intl/server";
import { OrganizationList } from "../../../../components/org/organization-list";
import {
  PageCard,
  PageCardContent,
  PageCardDescription,
  PageCardFooter,
  PageCardHeader,
  PageCardTitle,
} from "../../../../components/public/page-card";
import { Link } from "../../../../i18n/navigation";
import { requireLocale } from "../../../../i18n/require-locale";
import { readActiveOrgCookie } from "../../../../lib/tenant/active-org-cookie";
import { listMyMemberships, type ActiveMembership } from "../../../../lib/tenant/memberships";
import { TenantError } from "../../../../lib/tenant/tenant-error";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Choix de l'organisation active. N'appelle PAS requireTenantContext (qui redirige ici) : liste
 * seulement mes adhésions actives, relues en base ; le cookie sert d'indice d'affichage.
 */
export default async function SelectOrganizationPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = await requireLocale(params);
  const t = await getTranslations({ locale, namespace: "Org" });

  let memberships: ActiveMembership[];
  try {
    memberships = await listMyMemberships();
  } catch (error) {
    if (error instanceof TenantError) redirect(`/${locale}/login`);
    throw error;
  }
  if (memberships.length === 0) redirect(`/${locale}/onboarding`);

  const hint = await readActiveOrgCookie();
  const currentId = memberships.find((m) => m.organizationId === hint)?.organizationId;

  return (
    <PageCard className="max-w-lg">
      <PageCardHeader>
        <PageCardTitle>{t("select.title")}</PageCardTitle>
        <PageCardDescription>{t("select.description")}</PageCardDescription>
      </PageCardHeader>
      <PageCardContent>
        <OrganizationList
          currentId={currentId}
          items={memberships.map((m) => ({
            id: m.organizationId,
            name: m.organization.name,
            role: m.role,
            status: m.organization.status,
          }))}
        />
      </PageCardContent>
      <PageCardFooter>
        <Link href="/onboarding" className="text-primary-text font-medium underline-offset-4 hover:underline">
          {t("select.createNew")}
        </Link>
      </PageCardFooter>
    </PageCard>
  );
}
