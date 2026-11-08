import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

type Props = {
  /** `brand` : sur le fond en dégradé des pages publiques (texte clair) ; `default` : sur le fond de l'application. */
  tone?: "default" | "brand";
  className?: string;
};

/**
 * Pied de page commun à toutes les pages (application, connexion, invitation, accueil). Texte seul :
 * aucun lien tant que les pages légales n'existent pas. Couleurs par jetons (palette et mode sombre).
 */
export function AppFooter({ tone = "default", className }: Props) {
  const t = useTranslations("Footer");
  const tc = useTranslations("Common");
  return (
    <footer
      className={cn(
        "shrink-0 px-4 py-4 text-center text-xs sm:px-6",
        tone === "brand" ? "text-white/90" : "text-muted-foreground border-t",
        className,
      )}
    >
      <p>{t("copyright", { year: new Date().getFullYear(), appName: tc("appName") })}</p>
    </footer>
  );
}
