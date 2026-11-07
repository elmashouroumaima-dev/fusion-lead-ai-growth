import { SUPPORTED_TIME_ZONES } from "@fusion-leap/domain";
import { getTranslations } from "next-intl/server";
import { CreateOrganizationForm } from "../../../../components/org/create-organization-form";
import { requireLocale } from "../../../../i18n/require-locale";

// Rendu dynamique : la clé de création doit être différente à chaque affichage de la page.
export const dynamic = "force-dynamic";

export default async function OnboardingPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = await requireLocale(params);
  const t = await getTranslations({ locale, namespace: "Org" });

  return (
    <section className="card">
      <h1>{t("onboarding.title")}</h1>
      <p className="lead">{t("onboarding.description")}</p>
      <CreateOrganizationForm creationKey={crypto.randomUUID()} timeZones={SUPPORTED_TIME_ZONES} />
    </section>
  );
}
