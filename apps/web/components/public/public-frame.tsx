import type { ReactNode } from "react";
import { LanguageSwitcher } from "@/components/layout/language-switcher";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { cn } from "@/lib/utils";

type Props = {
  children: ReactNode;
  /** Colonne de marque (début) à côté du contenu (fin), ou contenu seul centré. */
  brand?: ReactNode;
  className?: string;
};

/**
 * Cadre des pages publiques (connexion, inscription, invitation, accueil) : fond en dégradé de marque
 * sur toute la hauteur, voile sombre (contraste AA du texte blanc), langue et thème en haut côté « fin »,
 * puis <main id="main"> (cible du lien d'évitement). Empilé sur mobile ; deux colonnes dès `lg`.
 * Les commandes reposent sur une pastille opaque : lisibles quel que soit le thème.
 */
export function PublicFrame({ children, brand, className }: Props) {
  return (
    <div className="relative isolate flex min-h-svh flex-col overflow-hidden bg-brand-gradient">
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-black/45 dark:bg-black/65" />
      <header className="flex items-center justify-end p-4 lg:px-8">
        <div className="bg-background/95 text-foreground flex items-center gap-1 rounded-lg border p-1 shadow-sm">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </header>
      <main
        id="main"
        className={cn(
          "mx-auto grid w-full max-w-6xl flex-1 content-start items-center justify-items-center gap-6 px-4 pb-10 sm:px-6 lg:px-8",
          brand ? "lg:grid-cols-2 lg:content-center lg:gap-12" : "content-center",
          className,
        )}
      >
        {brand ? <div className="w-full justify-self-start">{brand}</div> : null}
        <div className={cn("flex w-full justify-center", brand && "lg:justify-end")}>{children}</div>
      </main>
    </div>
  );
}
