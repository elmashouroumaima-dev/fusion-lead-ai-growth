"use client";

import { useTranslations } from "next-intl";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

type SuccessKey = "removed" | "revoked";
export type Announce = (key: SuccessKey, focusId: string) => void;

const noop: Announce = () => undefined;
const AnnounceContext = createContext<Announce>(noop);

/** Annonce un succès dans la région live de la PAGE (jamais dans la ligne retirée) et replace le focus. */
export function useAnnounce(): Announce {
  return useContext(AnnounceContext);
}

type Message = { key: SuccessKey; focusId: string; n: number };

/**
 * Région live de page : montée en permanence (même vide) pour que les lecteurs d'écran annoncent le
 * texte quand il apparaît ; le même message s'affiche aussi en notification (toast). Après un retrait /
 * une révocation, la ligne disparaît : le focus est rendu au titre de la liste concernée (tabIndex=-1),
 * qui n'est jamais retiré.
 */
export function MembersPageFeedback({ children }: { children: ReactNode }) {
  const t = useTranslations("Members");
  const [message, setMessage] = useState<Message | null>(null);

  const announce = useCallback<Announce>(
    (key, focusId) => {
      setMessage((prev) => ({ key, focusId, n: (prev?.n ?? 0) + 1 }));
      toast.success(t(`success.${key}`));
    },
    [t],
  );
  const value = useMemo(() => announce, [announce]);

  useEffect(() => {
    if (message) document.getElementById(message.focusId)?.focus();
  }, [message]);

  return (
    <AnnounceContext.Provider value={value}>
      <div className="sr-only" role="status" aria-live="polite">
        {message ? <p>{t(`success.${message.key}`)}</p> : null}
      </div>
      {children}
    </AnnounceContext.Provider>
  );
}
