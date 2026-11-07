"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { revokeInvitationAction } from "../../lib/members/actions";
import type { MembersActionState } from "../../lib/members/types";
import { ActionFeedback } from "./action-feedback";
import { useAnnounce } from "./page-feedback";

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
    // Erreur : annoncée uniquement par la région live d'ActionFeedback (un seul canal, pas de toast d'erreur).
    // La ligne disparaît après la révocation : le succès (toast + région live) est annoncé au niveau de la page.
    if (result.status === "success") announce("revoked", "pending-title");
    return result;
  }, initialState);

  return (
    <div className="flex flex-col items-end gap-1">
      <form action={formAction}>
        <input type="hidden" name="uiLocale" value={uiLocale} />
        <input type="hidden" name="organization_id" value={organizationId} />
        <input type="hidden" name="invitation_id" value={invitationId} />
        <Button type="submit" variant="outline" size="sm" disabled={pending} aria-label={t("invitations.revokeLabel", { email: subject })}>
          {t("invitations.revoke")}
        </Button>
      </form>
      <ActionFeedback state={state} />
    </div>
  );
}
