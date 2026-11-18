import { localeSchema } from "@fusion-leap/domain";
import { getTranslations } from "next-intl/server";
import { PaletteEditor } from "../../../../../components/settings/palette-editor";
import { RestrictedNotice } from "../../../../../components/settings/restricted-notice";
import { requireLocale } from "../../../../../i18n/require-locale";
import { requireClaims } from "../../../../../lib/auth/require-claims";
import { getPlatformPalette } from "../../../../../lib/service/platform-config";
import { canManagePlatformConfig } from "../../../../../lib/settings/queries";

export const dynamic = "force-dynamic";

/** Paramétrage > Palette de couleurs. Administrateurs de la plateforme seulement (ADR 016) ; la base revérifie à l'écriture. */
export default async function PaletteSettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = localeSchema.parse(await requireLocale(params));
  const t = await getTranslations({ locale, namespace: "Settings" });
  await requireClaims(locale);
  // Les autres rôles voient un message en lecture seule : ni éditeur, ni lecture de la palette.
  const allowed = await canManagePlatformConfig();
  const palette = allowed ? await getPlatformPalette() : null;

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6">
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("sections.palette")}</h1>
        {allowed ? <p className="text-muted-foreground max-w-prose text-sm">{t("description")}</p> : null}
      </header>
      {allowed ? <PaletteEditor initial={palette} /> : <RestrictedNotice locale={locale} />}
    </div>
  );
}
