import { localeSchema } from "@fusion-leap/domain";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { LogoEditor } from "../../../../../components/settings/logo-editor";
import { requireLocale } from "../../../../../i18n/require-locale";
import { requireClaims } from "../../../../../lib/auth/require-claims";
import { getPlatformLogoVersion } from "../../../../../lib/service/platform-config";
import { canManagePlatformConfig } from "../../../../../lib/settings/queries";

export const dynamic = "force-dynamic";

/** Paramétrage > Logo. Owner / admin d'organisation (ADR 016) ; la base revérifie à l'écriture. */
export default async function LogoSettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = localeSchema.parse(await requireLocale(params));
  const t = await getTranslations({ locale, namespace: "Settings" });
  await requireClaims(locale);
  if (!(await canManagePlatformConfig())) redirect(`/${locale}/dashboard`);

  const logoVersion = await getPlatformLogoVersion();

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6">
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("logo.title")}</h1>
        <p className="text-muted-foreground max-w-prose text-sm">{t("logo.description")}</p>
      </header>
      <LogoEditor currentSrc={logoVersion === null ? null : `/api/brand/logo?v=${logoVersion}`} />
    </div>
  );
}
