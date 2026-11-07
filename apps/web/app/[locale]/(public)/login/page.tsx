import { getTranslations } from "next-intl/server";
import { AuthForm } from "../../../../components/auth/auth-form";
import { parseInitialError } from "../../../../components/auth/initial-error";
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
import { signInAction } from "../../../../lib/auth/actions";

type PageProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ next?: string | string[]; error?: string | string[] }>;
};

export default async function LoginPage({ params, searchParams }: PageProps) {
  const locale = await requireLocale(params);
  const t = await getTranslations({ locale, namespace: "Auth" });
  const { next, error } = await searchParams;
  // Valeur brute transmise telle quelle ; l'action serveur la valide (safeNext).
  const nextValue = typeof next === "string" ? next : undefined;

  // Liste blanche stricte : jamais de texte libre issu de l'URL.
  const initialErrorCode = parseInitialError(error);

  return (
    <PageCard>
      <PageCardHeader>
        <PageCardTitle>{t("login.title")}</PageCardTitle>
        <PageCardDescription>{t("login.description")}</PageCardDescription>
      </PageCardHeader>
      <PageCardContent>
        <AuthForm
          action={signInAction}
          submitLabel={t("login.submit")}
          next={nextValue}
          initialErrorCode={initialErrorCode}
          passwordAction={
            <Link href="/forgot-password" className="text-primary-text text-sm font-medium underline-offset-4 hover:underline">
              {t("login.forgot")}
            </Link>
          }
          fields={[
            { name: "email", label: "email", type: "email", autoComplete: "email" },
            { name: "password", label: "password", type: "password", autoComplete: "current-password" },
          ]}
        />
      </PageCardContent>
      <PageCardFooter>
        <p className="text-muted-foreground">
          {t("login.noAccount")}{" "}
          <Link href="/signup" className="text-primary-text font-medium underline-offset-4 hover:underline">
            {t("login.toSignup")}
          </Link>
        </p>
      </PageCardFooter>
    </PageCard>
  );
}
