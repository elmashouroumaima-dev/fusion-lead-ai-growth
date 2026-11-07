import { paletteToCss } from "@fusion-leap/domain";
import { DirectionProvider } from "@radix-ui/react-direction";
import type { Metadata } from "next";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { BrandLogoProvider } from "@/components/brand/logo";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { getPlatformLogoVersion, getPlatformPalette } from "../../lib/service/platform-config";
import { getDirection } from "../../i18n/direction";
import { routing } from "../../i18n/routing";
import { poppins } from "../fonts/fonts";
import "../globals.css";

type LayoutProps = {
  children: ReactNode;
  params: Promise<{ locale: string }>;
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: Pick<LayoutProps, "params">): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Meta" });
  return { title: t("title"), description: t("description") };
}

/**
 * Racine : <html> (langue, direction, polices, thème), fournisseurs, lien d'évitement. Les en-têtes
 * et repères (<header>, <main id="main">) sont fournis par la coquille de chaque groupe de routes.
 */
export default async function LocaleLayout({ children, params }: LayoutProps) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "Common" });
  const dir = getDirection(locale);
  // Cairo n'est chargé (et préchargé) que pour l'arabe ; fr / en n'en téléchargent rien.
  const cairoVariable =
    locale === "ar" ? (await import("../fonts/cairo")).cairo.variable : undefined;

  // Palette GLOBALE de la plateforme (valeurs #rrggbb re-validées), sur toutes les pages, connexion comprise.
  const [palette, logoVersion] = await Promise.all([
    getPlatformPalette(),
    getPlatformLogoVersion(),
  ]);
  // Logo personnalisé éventuel : URL versionnée de notre route (jamais une URL libre).
  const logoSrc = logoVersion === null ? null : `/api/brand/logo?v=${logoVersion}`;

  return (
    <html lang={locale} dir={dir} suppressHydrationWarning className={cn(poppins.variable, cairoVariable)}>
      <body>
        {palette ? <style dangerouslySetInnerHTML={{ __html: paletteToCss(palette) }} /> : null}
        <ThemeProvider>
          <DirectionProvider dir={dir}>
            <NextIntlClientProvider>
              <BrandLogoProvider src={logoSrc}>
                <a
                  href="#main"
                  className="bg-primary text-primary-foreground focus-visible:ring-ring absolute start-4 top-4 z-50 -translate-y-24 rounded-md px-4 py-2 text-sm font-medium transition-transform focus:translate-y-0 focus-visible:ring-2"
                >
                  {t("skipToContent")}
                </a>
                {children}
                <Toaster dir={dir} containerAriaLabel={t("notifications")} />
              </BrandLogoProvider>
            </NextIntlClientProvider>
          </DirectionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
