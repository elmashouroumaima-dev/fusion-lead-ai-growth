"use client";

import type { ReactNode } from "react";
import { usePathname } from "../../i18n/navigation";
import styles from "./organization.module.css";

/** Pages où le sélecteur d'en-tête est redondant (on y choisit ou crée déjà une organisation). */
export const SWITCHER_HIDDEN_PATHS: readonly string[] = ["/onboarding", "/select-organization"];

export const isSwitcherHiddenPath = (pathname: string): boolean =>
  SWITCHER_HIDDEN_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));

/**
 * Barre d'en-tête de l'application : n'affiche le sélecteur (passé en enfant) que hors des pages
 * d'onboarding et de sélection. `usePathname` de next-intl renvoie le chemin SANS préfixe de locale.
 */
export function SwitcherSlot({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (isSwitcherHiddenPath(pathname)) return null;
  return <div className={styles.appBar}>{children}</div>;
}
