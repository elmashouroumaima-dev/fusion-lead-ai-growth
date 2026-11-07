import { getTranslations } from "next-intl/server";
import { AuthForm } from "../../../../components/auth/auth-form";
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
import { requestPasswordResetAction } from "../../../../lib/auth/actions";

export default async function ForgotPasswordPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = await requireLocale(params);
  const t = await getTranslations({ locale, namespace: "Auth" });

  return (
    <PageCard>
      <PageCardHeader>
        <PageCardTitle>{t("forgotPassword.title")}</PageCardTitle>
        <PageCardDescription>{t("forgotPassword.description")}</PageCardDescription>
      </PageCardHeader>
      <PageCardContent>
        <AuthForm
          action={requestPasswordResetAction}
          submitLabel={t("forgotPassword.submit")}
          successMessage={t("success.requestReset")}
          fields={[{ name: "email", label: "email", type: "email", autoComplete: "email" }]}
        />
      </PageCardContent>
      <PageCardFooter>
        <Link href="/login" className="text-primary-text font-medium underline-offset-4 hover:underline">
          {t("forgotPassword.backToLogin")}
        </Link>
      </PageCardFooter>
    </PageCard>
  );
}
