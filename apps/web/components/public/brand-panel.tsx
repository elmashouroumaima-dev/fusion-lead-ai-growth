import { ShieldCheckIcon, UserCheckIcon, ZapIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { OfficialLogo } from "@/components/brand/official-logo";
import { cn } from "@/lib/utils";

const FEATURES = [
  { key: "secure", Icon: ShieldCheckIcon },
  { key: "fast", Icon: ZapIcon },
  { key: "governed", Icon: UserCheckIcon },
] as const;

/** Trois puces (sécurisé / rapide / sous contrôle). Texte blanc sur voile sombre : contraste AA. */
export function FeatureChips({ className }: { className?: string }) {
  const t = useTranslations("Auth.brand");
  return (
    <ul aria-label={t("featuresLabel")} className={cn("flex flex-wrap gap-2", className)}>
      {FEATURES.map(({ key, Icon }) => (
        <li
          key={key}
          className="inline-flex items-center gap-1.5 rounded-full border border-white/40 bg-white/15 px-3 py-1.5 text-sm font-medium text-white"
        >
          <Icon className="size-4" aria-hidden="true" />
          {t(`features.${key}`)}
        </li>
      ))}
    </ul>
  );
}

/**
 * Bloc de marque du côté « début » des pages publiques : logo, nom du produit, accroche, puces.
 * Compact sur mobile (accroche et puces restent, taille réduite).
 */
export function BrandPanel({ className }: { className?: string }) {
  const tc = useTranslations("Common");
  const th = useTranslations("Home");
  return (
    <section aria-label={tc("appName")} className={cn("grid max-w-xl gap-4 text-white lg:gap-6", className)}>
      <OfficialLogo alt={tc("appName")} priority className="w-56 lg:w-80" />
      <p className="text-sm leading-relaxed text-white/95 lg:text-lg">{th("tagline")}</p>
      <FeatureChips className="hidden sm:flex" />
    </section>
  );
}
