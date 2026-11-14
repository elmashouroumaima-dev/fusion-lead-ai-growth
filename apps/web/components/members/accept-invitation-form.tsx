"use client";

import { CircleAlertIcon, LoaderCircleIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";
import { alertVariants } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
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
  const failed = state.status === "error";

  return (
    <form action={formAction} className="grid gap-4" aria-busy={pending}>
      <input type="hidden" name="uiLocale" value={uiLocale} />
      <input type="hidden" name="token" value={token} />
      <div role="alert" aria-live="assertive" className={cn(failed ? alertVariants({ variant: "destructive" }) : "sr-only")}>
        {failed ? (
          <>
            <CircleAlertIcon aria-hidden="true" />
            <span className="col-start-2">{t("errors.invitation_invalid")}</span>
          </>
        ) : null}
      </div>
      <Button
        type="submit"
        size="lg"
        disabled={pending}
        className="h-11 w-full font-semibold"
      >
        {pending ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : null}
        {pending ? tc("submitting") : t("accept")}
      </Button>
    </form>
  );
}
