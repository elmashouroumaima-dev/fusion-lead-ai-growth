"use client";

import Image from "next/image";
import { createContext, useContext, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Logo personnalisé de la plateforme (ADR 016) : URL versionnée de `/api/brand/logo`, fournie par le layout de
 * locale. `null` = logo par défaut (marque graphique ci-dessous).
 */
const BrandLogoContext = createContext<string | null>(null);

export function BrandLogoProvider({ src, children }: { src: string | null; children: ReactNode }) {
  return <BrandLogoContext.Provider value={src}>{children}</BrandLogoContext.Provider>;
}

/**
 * Marque graphique : logo personnalisé (`<img>`, jamais d'URL arbitraire : seulement celle du contexte) ou SVG
 * en ligne par défaut. Décorative : le nom est donné par le texte voisin.
 */
export function LogoMark({ className }: { className?: string | undefined }) {
  const custom = useContext(BrandLogoContext);
  if (custom) {
    // `unoptimized` : l'image vient de notre route (/api/brand/logo), déjà validée et plafonnée à 128 Ko.
    return (
      <Image
        src={custom}
        alt=""
        aria-hidden="true"
        draggable={false}
        unoptimized
        width={64}
        height={64}
        className={cn("size-8 shrink-0 rounded-lg object-contain", className)}
      />
    );
  }
  // Marque « F » officielle (noir ; inversée en blanc en mode sombre). Fichier statique : `public/brand/mark.png`.
  return (
    <Image
      src="/brand/mark.png"
      alt=""
      aria-hidden="true"
      draggable={false}
      unoptimized
      width={282}
      height={256}
      className={cn("h-7 w-auto shrink-0 object-contain dark:invert", className)}
    />
  );
}

/** Marque + nom « Fusion Leap » (nom de marque, volontairement non traduit). */
export function Brand({
  className,
  markClassName,
  textClassName,
}: {
  className?: string;
  markClassName?: string;
  textClassName?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark className={markClassName} />
      <span className={cn("text-base font-semibold tracking-tight", textClassName)}>
        Fusion Leap
      </span>
    </span>
  );
}
