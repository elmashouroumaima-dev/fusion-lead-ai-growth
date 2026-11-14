"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState, useEffect, useId } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { assignConversationAction, setConversationStateAction } from "../../lib/inbox/actions";
import { NO_ASSIGNEE } from "../../lib/inbox/action-schemas";
import type { InboxActionState } from "../../lib/inbox/types";

/**
 * Commandes d'un fil (J37) : assigner (owner et admin) et changer l'état (owner et admin, le commercial sur ses conversations). Chaque
 * formulaire porte une clé d'idempotence générée par le serveur à chaque rendu ; l'entreprise n'est pas postée (elle vient du
 * contexte vérifié). Le serveur revalide tout : rôle, responsable assignable, état cohérent avec le responsable.
 */

const initialState: InboxActionState = { status: "idle" };

function useFeedback(state: InboxActionState): string {
  const t = useTranslations("Inbox");
  useEffect(() => {
    if (state.status === "success" && state.success) toast.success(t(`success.${state.success}`));
  }, [state, t]);
  return state.status === "error" ? t(`errors.${state.code ?? "generic"}`) : "";
}

type Common = { conversationId: string; idempotencyKey: string };

export function AssignConversationForm({
  conversationId,
  idempotencyKey,
  currentAssigneeId,
  members,
}: Common & { currentAssigneeId: string | null; members: { value: string; label: string }[] }) {
  const t = useTranslations("Inbox");
  const uiLocale = useLocale();
  const uid = useId();
  const [state, formAction, pending] = useActionState(assignConversationAction, initialState);
  const error = useFeedback(state);
  return (
    <form action={formAction} className="grid gap-2">
      <input type="hidden" name="uiLocale" value={uiLocale} />
      <input type="hidden" name="conversation_id" value={conversationId} />
      <input type="hidden" name="idempotency_key" value={idempotencyKey} />
      <Label htmlFor={`${uid}-assignee`}>{t("thread.assign.label")}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Select name="assignee_id" defaultValue={currentAssigneeId ?? NO_ASSIGNEE}>
          <SelectTrigger id={`${uid}-assignee`} className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_ASSIGNEE}>{t("thread.assign.none")}</SelectItem>
            {members.map((member) => (
              <SelectItem key={member.value} value={member.value}>
                <bdi>{member.label}</bdi>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? t("thread.saving") : t("thread.assign.submit")}
        </Button>
      </div>
      <div role="status" aria-live="polite" className="empty:hidden">
        {error ? <p className="text-destructive-text text-sm">{error}</p> : null}
      </div>
    </form>
  );
}

/** États proposés : « à trier » seulement sans responsable ; « ouverte » et « en attente » seulement avec un responsable (règles de la base). */
export function ConversationStateForm({
  conversationId,
  idempotencyKey,
  currentState,
  hasAssignee,
}: Common & { currentState: "open" | "pending" | "closed" | "to_triage"; hasAssignee: boolean }) {
  const t = useTranslations("Inbox");
  const uiLocale = useLocale();
  const uid = useId();
  const [state, formAction, pending] = useActionState(setConversationStateAction, initialState);
  const error = useFeedback(state);
  const options = (hasAssignee ? ["open", "pending", "closed"] : ["to_triage", "closed"]) as ("open" | "pending" | "closed" | "to_triage")[];
  return (
    <form action={formAction} className="grid gap-2">
      <input type="hidden" name="uiLocale" value={uiLocale} />
      <input type="hidden" name="conversation_id" value={conversationId} />
      <input type="hidden" name="idempotency_key" value={idempotencyKey} />
      <Label htmlFor={`${uid}-state`}>{t("thread.state.label")}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Select name="state" defaultValue={options.includes(currentState) ? currentState : options[0]}>
          <SelectTrigger id={`${uid}-state`} className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`states.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? t("thread.saving") : t("thread.state.submit")}
        </Button>
      </div>
      <div role="status" aria-live="polite" className="empty:hidden">
        {error ? <p className="text-destructive-text text-sm">{error}</p> : null}
      </div>
    </form>
  );
}
