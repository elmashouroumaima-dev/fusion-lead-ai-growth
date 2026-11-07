"use client";

import { useTranslations } from "next-intl";
import type { MembersActionState } from "../../lib/members/types";
import styles from "./members.module.css";

type Props = {
  state: MembersActionState;
  /** Clé `Members.success.*` affichée en cas de succès (absente : rien n'est affiché). */
  successKey?: "roleChanged" | "removed" | "transferred" | "revoked";
};

/**
 * Zone d'annonce : le conteneur `aria-live` est toujours présent (monté avant le message) pour que
 * les lecteurs d'écran annoncent le résultat. Les actions ne renvoient que des codes, traduits ici.
 */
export function ActionFeedback({ state, successKey }: Props) {
  const t = useTranslations("Members");
  return (
    <div className={styles.feedback} role="status" aria-live="polite">
      {state.status === "error" ? <p className="notice notice-error">{t(`errors.${state.code ?? "generic"}`)}</p> : null}
      {state.status === "success" && successKey ? <p className="notice notice-success">{t(`success.${successKey}`)}</p> : null}
    </div>
  );
}
