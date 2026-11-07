import { SUPPORTED_TIME_ZONES } from "@fusion-leap/domain";
import { getTranslations } from "next-intl/server";
import { CreateOrganizationForm } from "../../../../components/org/create-organization-form";
import {
  PageCard,
  PageCardContent,
  PageCardDescription,
  PageCardHeader,
  PageCardTitle,
} from "../../../../components/public/page-card";
import { requireLocale } from "../../../../i18n/require-locale";

// Rendu dynamique : la clé de création doit être différente à chaque affichage de la page.
export const dynamic = "force-dynamic";

export default async function OnboardingPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = await requireLocale(params);
  const t = await getTranslations({ locale, namespace: "Org" });

  return (
    <PageCard className="max-w-lg">
      <PageCardHeader>
        <PageCardTitle>{t("onboarding.title")}</PageCardTitle>
        <PageCardDescription>{t("onboarding.description")}</PageCardDescription>
      </PageCardHeader>
      <PageCardContent>
        <CreateOrganizationForm creationKey={crypto.randomUUID()} timeZones={SUPPORTED_TIME_ZONES} />
      </PageCardContent>
    </PageCard>
  );
}
