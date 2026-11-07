import { getTranslations } from "next-intl/server";
import { SignOutForm } from "../../../../components/auth/sign-out-form";
import { requireLocale } from "../../../../i18n/require-locale";
import { requireClaims } from "../../../../lib/auth/require-claims";

export default async function DashboardPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = await requireLocale(params);
  const t = await getTranslations({ locale, namespace: "Dashboard" });
  const claims = await requireClaims(locale);
  const email = typeof claims.email === "string" ? claims.email : null;

  return (
    <section className="card">
      <h1>{t("title")}</h1>
      <p className="lead">
        {t("signedInAs")} <bdi dir="ltr">{email ?? t("unknownUser")}</bdi>
      </p>
      <p>{t("placeholder")}</p>
      <div className="actions">
        <SignOutForm />
      </div>
    </section>
  );
}
