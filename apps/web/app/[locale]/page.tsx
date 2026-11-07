import { ArrowRightIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { LogoMark } from "@/components/brand/logo";
import { FeatureChips } from "@/components/public/brand-panel";
import { PublicFrame } from "@/components/public/public-frame";
import { Button } from "@/components/ui/button";
import { Link } from "../../i18n/navigation";
import { requireLocale } from "../../i18n/require-locale";

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = await requireLocale(params);
  const t = await getTranslations({ locale, namespace: "Home" });

  return (
    <PublicFrame>
      <section className="grid max-w-2xl justify-items-center gap-6 text-center text-white">
        <LogoMark className="size-16 lg:size-20" />
        <h1 className="text-3xl leading-tight font-bold tracking-tight sm:text-5xl">{t("title")}</h1>
        <p className="text-base leading-relaxed text-white/95 sm:text-xl">{t("tagline")}</p>
        <FeatureChips className="justify-center" />
        <div className="flex flex-wrap justify-center gap-3 pt-2">
          <Button asChild size="lg" className="bg-white text-neutral-900 hover:bg-white/90">
            <Link href="/login">
              {t("login")}
              <ArrowRightIcon className="rtl:-scale-x-100" aria-hidden="true" />
            </Link>
          </Button>
          <Button
            asChild
            size="lg"
            variant="outline"
            className="border-white bg-white/10 text-white hover:bg-white/20 hover:text-white"
          >
            <Link href="/signup">{t("signup")}</Link>
          </Button>
        </div>
      </section>
    </PublicFrame>
  );
}
