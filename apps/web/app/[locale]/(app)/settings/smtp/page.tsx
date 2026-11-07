import { localeSchema } from "@fusion-leap/domain";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { SmtpCard } from "../../../../../components/settings/smtp-card";
import { requireLocale } from "../../../../../i18n/require-locale";
import { isPlatformAdmin } from "../../../../../lib/admin/queries";
import { requireClaims } from "../../../../../lib/auth/require-claims";
import { getSmtpSettings } from "../../../../../lib/smtp/queries";
import { getKeyRing } from "../../../../../lib/smtp/secrets";

export const dynamic = "force-dynamic";

/** Paramétrage > SMTP. Administrateurs de la plateforme seulement (secret chiffré) ; la base revérifie à chaque appel. */
export default async function SmtpSettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = localeSchema.parse(await requireLocale(params));
  const t = await getTranslations({ locale, namespace: "Settings" });
  await requireClaims(locale);
  if (!(await isPlatformAdmin())) redirect(`/${locale}/dashboard`);

  const smtp = await getSmtpSettings();

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6">
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("smtp.title")}</h1>
        <p className="text-muted-foreground max-w-prose text-sm">{t("smtp.description")}</p>
      </header>
      <SmtpCard initial={smtp} secretsAvailable={getKeyRing() !== null} />
    </div>
  );
}
