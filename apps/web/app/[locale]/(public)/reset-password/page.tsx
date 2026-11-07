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
import { updatePasswordAction } from "../../../../lib/auth/actions";

export default async function ResetPasswordPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = await requireLocale(params);
  const t = await getTranslations({ locale, namespace: "Auth" });

  return (
    <PageCard>
      <PageCardHeader>
        <PageCardTitle>{t("resetPassword.title")}</PageCardTitle>
        <PageCardDescription>{t("resetPassword.description")}</PageCardDescription>
      </PageCardHeader>
      <PageCardContent>
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
      </PageCardContent>
      <PageCardFooter>
        <Link href="/login" className="text-primary-text font-medium underline-offset-4 hover:underline">
          {t("resetPassword.toLogin")}
        </Link>
      </PageCardFooter>
    </PageCard>
  );
}
