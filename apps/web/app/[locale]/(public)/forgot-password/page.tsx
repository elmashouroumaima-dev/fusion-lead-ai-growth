import { getTranslations } from "next-intl/server";
import { AuthForm } from "../../../../components/auth/auth-form";
import { Link } from "../../../../i18n/navigation";
import { requireLocale } from "../../../../i18n/require-locale";
import { requestPasswordResetAction } from "../../../../lib/auth/actions";

export default async function ForgotPasswordPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = await requireLocale(params);
  const t = await getTranslations({ locale, namespace: "Auth" });

  return (
    <section className="card">
      <h1>{t("forgotPassword.title")}</h1>
      <p className="lead">{t("forgotPassword.description")}</p>
      <AuthForm
        action={requestPasswordResetAction}
        submitLabel={t("forgotPassword.submit")}
        successMessage={t("success.requestReset")}
        fields={[{ name: "email", label: "email", type: "email", autoComplete: "email" }]}
      />
      <div className="links">
        <Link href="/login">{t("forgotPassword.backToLogin")}</Link>
      </div>
    </section>
  );
}
