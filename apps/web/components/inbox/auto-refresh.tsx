"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Actualisation de la boîte de réception par polling (ADR 013) : re-rend la page SERVEUR toutes les 15 secondes, seulement quand
 * l'onglet est visible, et tout de suite au retour dans l'onglet. Aucune donnée ne passe par ce composant : la page est redessinée par
 * le même chemin que le chargement initial (client serveur de l'utilisateur, RLS, contexte d'organisation relu en base), donc une
 * adhésion retirée ou un rôle rétrogradé prend effet au prochain rafraîchissement. L'état des formulaires du navigateur est conservé.
 */
export function AutoRefresh({ intervalMs = 15_000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = window.setInterval(refreshIfVisible, intervalMs);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [router, intervalMs]);
  return null;
}
