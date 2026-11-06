import { getTranslations } from "next-intl/server";
import { AuthForm } from "../../../../components/auth/auth-form";
import { Link } from "../../../../i18n/navigation";
import { requireLocale } from "../../../../i18n/require-locale";
import { signUpAction } from "../../../../lib/auth/actions";

export default async function SignupPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = await requireLocale(params);
  const t = await getTranslations({ locale, namespace: "Auth" });

  return (
    <section className="card">
      <h1>{t("signup.title")}</h1>
      <p className="lead">{t("signup.description")}</p>
      <AuthForm
        action={signUpAction}
        submitLabel={t("signup.submit")}
        successMessage={t("success.signUp")}
        fields={[
          { name: "email", label: "email", type: "email", autoComplete: "email" },
          {
            name: "password",
            label: "password",
            type: "password",
            autoComplete: "new-password",
            showPasswordHint: true,
          },
        ]}
      />
      <div className="links">
        <span>
          {t("signup.haveAccount")} <Link href="/login">{t("signup.toLogin")}</Link>
        </span>
      </div>
    </section>
  );
}
