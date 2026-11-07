import { getTranslations } from "next-intl/server";
import { Link } from "../../i18n/navigation";
import { requireLocale } from "../../i18n/require-locale";

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = await requireLocale(params);
  const t = await getTranslations({ locale, namespace: "Home" });

  return (
    <section className="card">
      <h1>{t("title")}</h1>
      <p className="lead">{t("tagline")}</p>
      <div className="actions">
        <Link className="btn" href="/login">
          {t("login")}
        </Link>
        <Link className="btn btn-secondary" href="/signup">
          {t("signup")}
        </Link>
      </div>
    </section>
  );
}
