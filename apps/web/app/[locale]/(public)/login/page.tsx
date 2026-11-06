import { getTranslations } from "next-intl/server";
import { AuthForm } from "../../../../components/auth/auth-form";
import { parseInitialError } from "../../../../components/auth/initial-error";
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
    <section className="card">
      <h1>{t("login.title")}</h1>
      <p className="lead">{t("login.description")}</p>
      <AuthForm
        action={signInAction}
        submitLabel={t("login.submit")}
        next={nextValue}
        initialErrorCode={initialErrorCode}
        fields={[
          { name: "email", label: "email", type: "email", autoComplete: "email" },
          { name: "password", label: "password", type: "password", autoComplete: "current-password" },
        ]}
      />
      <div className="links">
        <Link href="/forgot-password">{t("login.forgot")}</Link>
        <span>
          {t("login.noAccount")} <Link href="/signup">{t("login.toSignup")}</Link>
        </span>
      </div>
    </section>
  );
}
