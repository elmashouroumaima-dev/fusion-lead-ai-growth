import { getTranslations } from "next-intl/server";
import { SignOutForm } from "../../../../components/auth/sign-out-form";
import styles from "../../../../components/org/organization.module.css";
import { requireLocale } from "../../../../i18n/require-locale";
import { requireClaims } from "../../../../lib/auth/require-claims";
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

  return (
    <section className="card">
      <h1>{t("title")}</h1>
      <p className="lead">
        {t("signedInAs")} <bdi dir="ltr">{email ?? t("unknownUser")}</bdi>
      </p>
      <dl className={styles.details}>
        <dt>{to("dashboard.organization")}</dt>
        <dd>
          <bdi>{tenant.organization.name}</bdi>
        </dd>
        <dt>{to("dashboard.role")}</dt>
        <dd>{to(`roles.${tenant.role}`)}</dd>
      </dl>
      <p>{t("placeholder")}</p>
      <div className="actions">
        <SignOutForm />
      </div>
    </section>
  );
}
