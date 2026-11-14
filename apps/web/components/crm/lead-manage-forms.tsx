"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState, useEffect, useId, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { assignLeadAction, createDealAction, moveDealStageAction, moveLeadStageAction } from "../../lib/leads/actions";
import { DEAL_CURRENCIES, DEFAULT_DEAL_CURRENCY, NO_ASSIGNEE } from "../../lib/leads/form-options";
import type { LeadsActionState } from "../../lib/leads/types";

/**
 * Formulaires de la fiche lead (J30d) : étape du lead, assignation (owner et admin), création d'un deal, déplacement d'un deal et
 * boutons « gagné » / « perdu ». Chaque formulaire porte l'organisation (comparée au contexte vérifié côté serveur) et une clé
 * d'idempotence générée par le serveur à chaque rendu. Le serveur revalide tout : rôle, propriété du lead, étape, entrée.
 */

const initialState: LeadsActionState = { status: "idle" };

type Common = { organizationId: string; idempotencyKey: string };
type StageOption = { id: string; name: string };

function useFeedback(state: LeadsActionState): string {
  const t = useTranslations("Lead");
  useEffect(() => {
    if (state.status === "success" && state.success) toast.success(t(`manage.success.${state.success}`));
  }, [state, t]);
  return state.status === "error" ? t(`errors.${state.code ?? "generic"}`) : "";
}

function Hidden({ organizationId, idempotencyKey }: Common) {
  const uiLocale = useLocale();
  return (
    <>
      <input type="hidden" name="uiLocale" value={uiLocale} />
      <input type="hidden" name="organization_id" value={organizationId} />
      <input type="hidden" name="idempotency_key" value={idempotencyKey} />
    </>
  );
}

function Feedback({ error }: { error: string }) {
  return (
    <div role="status" aria-live="polite" className="empty:hidden">
      {error ? <p className="text-destructive-text text-sm">{error}</p> : null}
    </div>
  );
}

export function LeadStageForm({ leadId, currentStageId, stages, ...common }: Common & { leadId: string; currentStageId: string; stages: StageOption[] }) {
  const t = useTranslations("Lead");
  const uid = useId();
  const [state, formAction, pending] = useActionState(moveLeadStageAction, initialState);
  const error = useFeedback(state);
  return (
    <form action={formAction} className="grid gap-2">
      <Hidden {...common} />
      <input type="hidden" name="lead_id" value={leadId} />
      <Label htmlFor={`${uid}-stage`}>{t("manage.stage.label")}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Select name="stage_id" defaultValue={currentStageId}>
          <SelectTrigger id={`${uid}-stage`} className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {stages.map((stage) => (
              <SelectItem key={stage.id} value={stage.id}>
                <bdi>{stage.name}</bdi>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? t("manage.saving") : t("manage.stage.submit")}
        </Button>
      </div>
      <Feedback error={error} />
    </form>
  );
}

export function AssignLeadForm({
  leadId,
  currentAssigneeId,
  members,
  ...common
}: Common & { leadId: string; currentAssigneeId: string | null; members: { value: string; label: string }[] }) {
  const t = useTranslations("Lead");
  const uid = useId();
  const [state, formAction, pending] = useActionState(assignLeadAction, initialState);
  const error = useFeedback(state);
  return (
    <form action={formAction} className="grid gap-2">
      <Hidden {...common} />
      <input type="hidden" name="lead_id" value={leadId} />
      <Label htmlFor={`${uid}-assignee`}>{t("manage.assign.label")}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Select name="assignee_id" defaultValue={currentAssigneeId ?? NO_ASSIGNEE}>
          <SelectTrigger id={`${uid}-assignee`} className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_ASSIGNEE}>{t("manage.assign.none")}</SelectItem>
            {members.map((member) => (
              <SelectItem key={member.value} value={member.value}>
                <bdi>{member.label}</bdi>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? t("manage.saving") : t("manage.assign.submit")}
        </Button>
      </div>
      <Feedback error={error} />
    </form>
  );
}

export function CreateDealForm({ leadId, stages, ...common }: Common & { leadId: string; stages: StageOption[] }) {
  const t = useTranslations("Lead");
  const uid = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState(createDealAction, initialState);
  const error = useFeedback(state);

  useEffect(() => {
    if (state.status === "success") formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="grid gap-4">
      <Hidden {...common} />
      <input type="hidden" name="lead_id" value={leadId} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${uid}-value`}>{t("deals.new.value")}</Label>
          <Input id={`${uid}-value`} name="value" required inputMode="decimal" dir="ltr" placeholder="0.00" autoComplete="off" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${uid}-currency`}>{t("deals.new.currency")}</Label>
          <Select name="currency" defaultValue={DEFAULT_DEAL_CURRENCY}>
            <SelectTrigger id={`${uid}-currency`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DEAL_CURRENCIES.map((currency) => (
                <SelectItem key={currency} value={currency}>
                  {currency}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${uid}-close`}>{t("deals.new.close")}</Label>
          <Input id={`${uid}-close`} name="expected_close_date" type="date" dir="ltr" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${uid}-stage`}>{t("deals.new.stage")}</Label>
          <Select name="stage_id" defaultValue={stages[0]?.id}>
            <SelectTrigger id={`${uid}-stage`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {stages.map((stage) => (
                <SelectItem key={stage.id} value={stage.id}>
                  <bdi>{stage.name}</bdi>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <Feedback error={error} />
      <Button type="submit" className="w-fit" disabled={pending}>
        {pending ? t("manage.saving") : t("deals.new.submit")}
      </Button>
    </form>
  );
}

/** Déplace un deal vers une étape choisie (menu) ; les boutons « gagné » et « perdu » sont `DealQuickForm`. */
export function DealStageForm({ dealId, currentStageId, stages, ...common }: Common & { dealId: string; currentStageId: string; stages: StageOption[] }) {
  const t = useTranslations("Lead");
  const uid = useId();
  const [state, formAction, pending] = useActionState(moveDealStageAction, initialState);
  const error = useFeedback(state);
  return (
    <form action={formAction} className="grid gap-1.5">
      <Hidden {...common} />
      <input type="hidden" name="deal_id" value={dealId} />
      <Label htmlFor={`${uid}-stage`} className="sr-only">
        {t("deals.move.label")}
      </Label>
      <div className="flex flex-wrap items-center gap-2">
        <Select name="stage_id" defaultValue={currentStageId}>
          <SelectTrigger id={`${uid}-stage`} size="sm" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {stages.map((stage) => (
              <SelectItem key={stage.id} value={stage.id}>
                <bdi>{stage.name}</bdi>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {t("deals.move.submit")}
        </Button>
      </div>
      <Feedback error={error} />
    </form>
  );
}

/** Bouton « gagné » ou « perdu » : déplace le deal vers l'étape de ce genre du pipeline (la base pose la date). */
export function DealQuickForm({ dealId, stageId, outcome, ...common }: Common & { dealId: string; stageId: string; outcome: "won" | "lost" }) {
  const t = useTranslations("Lead");
  const [state, formAction, pending] = useActionState(moveDealStageAction, initialState);
  const error = useFeedback(state);
  return (
    <form action={formAction} className="flex items-center gap-2">
      <Hidden {...common} />
      <input type="hidden" name="deal_id" value={dealId} />
      <input type="hidden" name="stage_id" value={stageId} />
      <Button type="submit" size="sm" variant={outcome === "won" ? "default" : "ghost"} disabled={pending}>
        {outcome === "won" ? t("deals.won") : t("deals.lost")}
      </Button>
      <span role="status" aria-live="polite" className="text-destructive-text text-xs empty:hidden">
        {error}
      </span>
    </form>
  );
}
