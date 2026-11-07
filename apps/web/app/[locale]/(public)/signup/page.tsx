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
import { signUpAction } from "../../../../lib/auth/actions";

export default async function SignupPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = await requireLocale(params);
  const t = await getTranslations({ locale, namespace: "Auth" });

  return (
    <PageCard>
      <PageCardHeader>
        <PageCardTitle>{t("signup.title")}</PageCardTitle>
        <PageCardDescription>{t("signup.description")}</PageCardDescription>
      </PageCardHeader>
      <PageCardContent>
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
      </PageCardContent>
      <PageCardFooter>
        <p className="text-muted-foreground">
          {t("signup.haveAccount")}{" "}
          <Link href="/login" className="text-primary-text font-medium underline-offset-4 hover:underline">
            {t("signup.toLogin")}
          </Link>
        </p>
      </PageCardFooter>
    </PageCard>
  );
}
