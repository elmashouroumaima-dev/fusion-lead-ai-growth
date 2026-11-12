import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * Logo officiel « FUSION LEAP » (blanc, fond transparent) des pages publiques : connexion, inscription, invitation,
 * accueil. Fichier statique FIXE (`public/brand/logo-white.png`, 960×193 px pour les écrans denses) : il ne change
 * PAS avec le logo personnalisé du Paramétrage (celui-ci reste réservé à l'application connectée). Blanc : à n'utiliser
 * que sur le fond en dégradé de marque des pages publiques.
 */
export function OfficialLogo({ alt, className, priority = false }: { alt: string; className?: string; priority?: boolean }) {
  return (
    <Image
      src="/brand/logo-white.png"
      alt={alt}
      width={960}
      height={193}
      // Fichier statique déjà dimensionné : pas besoin de l'optimiseur d'images.
      unoptimized
      priority={priority}
      draggable={false}
      className={cn("h-auto w-64 max-w-full lg:w-80", className)}
    />
  );
}
