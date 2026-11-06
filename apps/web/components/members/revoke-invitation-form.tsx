"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";
import { revokeInvitationAction } from "../../lib/members/actions";
import type { MembersActionState } from "../../lib/members/types";
import { ActionFeedback } from "./action-feedback";
import { useAnnounce } from "./page-feedback";
import styles from "./members.module.css";

type Props = {
  organizationId: string;
  invitationId: string;
  /** Sujet lu par les technologies d'assistance (l'adresse invitée, visible pour owner/admin). */
  subject: string;
};

const initialState: MembersActionState = { status: "idle" };

export function RevokeInvitationForm({ organizationId, invitationId, subject }: Props) {
  const t = useTranslations("Members");
  const uiLocale = useLocale();
  const announce = useAnnounce();
  const [state, formAction, pending] = useActionState(async (prev: MembersActionState, formData: FormData) => {
    const result = await revokeInvitationAction(prev, formData);
    // La ligne disparaît après la révocation : le succès est annoncé au niveau de la page.
    if (result.status === "success") announce("revoked", "pending-title");
    return result;
  }, initialState);

  return (
    <div className={styles.fullWidth}>
      <form action={formAction} className={styles.inlineForm}>
        <input type="hidden" name="uiLocale" value={uiLocale} />
        <input type="hidden" name="organization_id" value={organizationId} />
        <input type="hidden" name="invitation_id" value={invitationId} />
        <button className="btn btn-secondary" type="submit" disabled={pending} aria-label={t("invitations.revokeLabel", { email: subject })}>
          {t("invitations.revoke")}
        </button>
      </form>
      <ActionFeedback state={state} />
    </div>
  );
}
