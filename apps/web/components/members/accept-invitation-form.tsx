"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";
import { acceptInvitationAction } from "../../lib/members/actions";
import type { MembersActionState } from "../../lib/members/types";

const initialState: MembersActionState = { status: "idle" };

/**
 * Bouton d'acceptation. Le jeton est repris de l'URL côté serveur et posté dans un champ caché ;
 * toute erreur est le même message générique (`invitation_invalid`).
 */
export function AcceptInvitationForm({ token }: { token: string }) {
  const t = useTranslations("Invite");
  const tc = useTranslations("Common");
  const uiLocale = useLocale();
  const [state, formAction, pending] = useActionState(acceptInvitationAction, initialState);

  return (
    <form action={formAction} className="form">
      <input type="hidden" name="uiLocale" value={uiLocale} />
      <input type="hidden" name="token" value={token} />
      <div role="alert" aria-live="assertive">
        {state.status === "error" ? <p className="notice notice-error">{t("errors.invitation_invalid")}</p> : null}
      </div>
      <button className="btn" type="submit" disabled={pending}>
        {pending ? tc("submitting") : t("accept")}
      </button>
    </form>
  );
}
