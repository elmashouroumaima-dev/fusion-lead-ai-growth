import { getTranslations } from "next-intl/server";
import { AuthForm } from "../../../../components/auth/auth-form";
import { Link } from "../../../../i18n/navigation";
import { requireLocale } from "../../../../i18n/require-locale";
import { updatePasswordAction } from "../../../../lib/auth/actions";

export default async function ResetPasswordPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = await requireLocale(params);
  const t = await getTranslations({ locale, namespace: "Auth" });

  return (
    <section className="card">
      <h1>{t("resetPassword.title")}</h1>
      <p className="lead">{t("resetPassword.description")}</p>
      <AuthForm
        action={updatePasswordAction}
        submitLabel={t("resetPassword.submit")}
        successMessage={t("success.updatePassword")}
        fields={[
          {
            name: "password",
            label: "newPassword",
            type: "password",
            autoComplete: "new-password",
            showPasswordHint: true,
          },
        ]}
      />
      <div className="links">
        <Link href="/login">{t("resetPassword.toLogin")}</Link>
      </div>
    </section>
  );
}
