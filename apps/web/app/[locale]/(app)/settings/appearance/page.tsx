import { localeSchema } from "@fusion-leap/domain";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { PaletteEditor } from "../../../../../components/settings/palette-editor";
import { requireLocale } from "../../../../../i18n/require-locale";
import { requireClaims } from "../../../../../lib/auth/require-claims";
import { getPlatformPalette } from "../../../../../lib/service/platform-config";
import { canManagePlatformConfig } from "../../../../../lib/settings/queries";

export const dynamic = "force-dynamic";

export default async function AppearanceSettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = localeSchema.parse(await requireLocale(params));
  const t = await getTranslations({ locale, namespace: "Settings" });
  await requireClaims(locale);

  // Owner / admin d'organisation seulement (ADR 016) ; la base revérifie à l'écriture.
  if (!(await canManagePlatformConfig())) redirect(`/${locale}/dashboard`);

  const palette = await getPlatformPalette();

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6">
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground max-w-prose text-sm">{t("description")}</p>
      </header>
      <PaletteEditor initial={palette} />
    </div>
  );
}
