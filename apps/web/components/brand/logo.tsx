import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Marque graphique (SVG en ligne, aucune image externe). Décorative : le nom est donné par le texte voisin. */
export function LogoMark({ className, ...props }: ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={cn("size-8 shrink-0", className)}
      {...props}
    >
      <rect width="32" height="32" rx="8" fill="#006a4e" />
      <path d="M9 22.5 15.5 9l3 6.2L22.8 9" stroke="#ffffff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 22.5h14" stroke="#ffffff" strokeWidth="2.6" strokeLinecap="round" opacity="0.55" />
      <circle cx="23.5" cy="22.5" r="1.8" fill="#ae2b2f" />
    </svg>
  );
}

/** Marque + nom « Fusion Leap » (nom de marque, volontairement non traduit). */
export function Brand({ className, markClassName, textClassName }: { className?: string; markClassName?: string; textClassName?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark className={markClassName} />
      <span className={cn("text-base font-semibold tracking-tight", textClassName)}>Fusion Leap</span>
    </span>
  );
}
