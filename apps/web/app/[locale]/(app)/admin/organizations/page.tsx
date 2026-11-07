import { PLAN_CODES, localeSchema, type AdminOrganizationRow, type PlanCode } from "@fusion-leap/domain";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SubscriptionForm } from "../../../../../components/admin/subscription-form";
import { requireLocale } from "../../../../../i18n/require-locale";
import { requireClaims } from "../../../../../lib/auth/require-claims";
import { isPlatformAdmin, listAdminOrganizations } from "../../../../../lib/admin/queries";

export const dynamic = "force-dynamic";

const planKey = (code: string | null): PlanCode | null => PLAN_CODES.find((c) => c === code) ?? null;

/** Administration de la plateforme : organisations et abonnements. Administrateurs de la plateforme seulement. */
export default async function AdminOrganizationsPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = localeSchema.parse(await requireLocale(params));
  const t = await getTranslations({ locale, namespace: "Admin" });
  await requireClaims(locale);
  if (!(await isPlatformAdmin())) redirect(`/${locale}/dashboard`);

  let organizations: AdminOrganizationRow[] | null = null;
  try {
    organizations = await listAdminOrganizations();
  } catch {
    organizations = null;
  }

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6">
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground max-w-prose text-sm">{t("description")}</p>
      </header>

      {organizations === null ? (
        <Alert variant="destructive" role="alert">
          {t("errors.loadFailed")}
        </Alert>
      ) : organizations.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("empty")}</p>
      ) : (
        organizations.map((organization) => (
          <Card key={organization.organization_id}>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
              <div className="grid gap-1">
                <CardTitle>
                  <bdi>{organization.name}</bdi>
                </CardTitle>
                <p className="text-muted-foreground text-xs">
                  <bdi dir="ltr" className="font-mono">
                    {organization.slug}
                  </bdi>{" "}
                  · {t("members", { count: organization.members })}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">{planKey(organization.plan_code) ? t(`plans.${planKey(organization.plan_code) as PlanCode}`) : t("noPlan")}</Badge>
                <Badge variant="outline">{organization.sub_status ? t(`status.${organization.sub_status}`) : t("noPlan")}</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <SubscriptionForm organization={organization} />
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
