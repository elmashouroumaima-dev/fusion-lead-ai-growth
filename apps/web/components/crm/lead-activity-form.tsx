"use client";

import { CALL_OUTCOMES } from "@fusion-leap/domain";
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { completeTaskAction, createActivityAction } from "../../lib/activities/actions";
import type { ActivitiesActionState } from "../../lib/activities/types";
import { cn } from "@/lib/utils";

/**
 * Formulaires de la fiche lead (J30c) : ajouter une note, un appel ou une tâche, et marquer une tâche faite ou à refaire. Chaque
 * formulaire porte l'organisation (comparée au contexte vérifié côté serveur) et une clé d'idempotence générée par le serveur à
 * chaque rendu. Le serveur revalide tout : rôle, propriété du lead, entrée.
 */

const initialState: ActivitiesActionState = { status: "idle" };
const KINDS = ["note", "call", "task"] as const;
type Kind = (typeof KINDS)[number];

type Common = { organizationId: string; idempotencyKey: string };

function useFeedback(state: ActivitiesActionState): string {
  const t = useTranslations("Lead");
  useEffect(() => {
    if (state.status === "success" && state.success) toast.success(t(`success.${state.success}`));
  }, [state, t]);
  return state.status === "error" ? t(`errors.${state.code ?? "generic"}`) : "";
}

export function LeadActivityForm({ leadId, organizationId, idempotencyKey }: Common & { leadId: string }) {
  const t = useTranslations("Lead");
  const uiLocale = useLocale();
  const uid = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [kind, setKind] = useState<Kind>("note");
  const [state, formAction, pending] = useActionState(createActivityAction, initialState);
  const error = useFeedback(state);

  // Après un succès, le formulaire se vide (le serveur redessine la chronologie avec une nouvelle clé d'idempotence).
  useEffect(() => {
    if (state.status === "success") formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="grid gap-4">
      <input type="hidden" name="uiLocale" value={uiLocale} />
      <input type="hidden" name="organization_id" value={organizationId} />
      <input type="hidden" name="lead_id" value={leadId} />
      <input type="hidden" name="idempotency_key" value={idempotencyKey} />
      <input type="hidden" name="type" value={kind} />

      <div role="group" aria-label={t("form.type")} className="bg-muted inline-flex w-fit gap-1 rounded-lg p-1">
        {KINDS.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={kind === value}
            onClick={() => setKind(value)}
            className={cn(
              "rounded-md px-4 py-1.5 text-sm font-medium transition",
              kind === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`form.kinds.${value}`)}
          </button>
        ))}
      </div>

      {kind === "task" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={`${uid}-title`}>{t("form.taskTitle")}</Label>
            <Input id={`${uid}-title`} name="title" required maxLength={200} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${uid}-due`}>{t("form.dueDate")}</Label>
            <Input id={`${uid}-due`} name="due_date" type="date" dir="ltr" />
          </div>
        </div>
      ) : null}

      {kind === "call" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={`${uid}-outcome`}>{t("form.outcome")}</Label>
            <Select name="outcome" defaultValue="answered">
              <SelectTrigger id={`${uid}-outcome`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CALL_OUTCOMES.map((outcome) => (
                  <SelectItem key={outcome} value={outcome}>
                    {t(`outcomes.${outcome}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${uid}-duration`}>{t("form.duration")}</Label>
            <Input id={`${uid}-duration`} name="duration_minutes" type="number" inputMode="numeric" min={0} max={600} step={1} dir="ltr" />
          </div>
        </div>
      ) : null}

      <div className="grid gap-1.5">
        <Label htmlFor={`${uid}-text`}>{kind === "note" ? t("form.noteText") : t("form.optionalText")}</Label>
        <Textarea id={`${uid}-text`} name="text" rows={3} maxLength={2000} required={kind === "note"} />
      </div>

      <div role="status" aria-live="polite" className="empty:hidden">
        {error ? <p className="text-destructive-text text-sm">{error}</p> : null}
      </div>
      <Button type="submit" className="w-fit" disabled={pending}>
        {pending ? t("form.saving") : t(`form.submit.${kind}`)}
      </Button>
    </form>
  );
}

/** Marque une tâche faite ou à refaire (un petit formulaire par tâche). */
export function TaskToggleForm({ activityId, organizationId, idempotencyKey, done }: Common & { activityId: string; done: boolean }) {
  const t = useTranslations("Lead");
  const uiLocale = useLocale();
  const [state, formAction, pending] = useActionState(completeTaskAction, initialState);
  const error = useFeedback(state);

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="uiLocale" value={uiLocale} />
      <input type="hidden" name="organization_id" value={organizationId} />
      <input type="hidden" name="activity_id" value={activityId} />
      <input type="hidden" name="idempotency_key" value={idempotencyKey} />
      <input type="hidden" name="done" value={done ? "false" : "true"} />
      <Button type="submit" size="sm" variant={done ? "ghost" : "outline"} disabled={pending}>
        {done ? t("task.reopen") : t("task.markDone")}
      </Button>
      <span role="status" aria-live="polite" className="text-destructive-text text-xs empty:hidden">
        {error}
      </span>
    </form>
  );
}
