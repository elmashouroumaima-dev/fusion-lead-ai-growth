"use client";

import { PLAN_CODES, PLAN_METRICS, SUBSCRIPTION_STATUSES, type AdminOrganizationRow, type PlanLimits, type PlanMetric } from "@fusion-leap/domain";
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { setSubscriptionAction } from "../../lib/admin/actions";
import type { AdminActionState } from "../../lib/admin/types";

const initialState: AdminActionState = { status: "idle" };

/** Surcharge de limites saisie champ par champ (vide = pas de surcharge pour cette métrique). */
function overrideJson(values: Partial<Record<PlanMetric, string>>): string {
  const limits: PlanLimits = {};
  for (const metric of PLAN_METRICS) {
    const raw = values[metric]?.trim();
    if (raw) limits[metric] = Number(raw);
  }
  return JSON.stringify(limits);
}

/** Formulaire d'activation d'un abonnement (administrateur de la plateforme). La base revérifie le droit. */
export function SubscriptionForm({ organization }: { organization: AdminOrganizationRow }) {
  const t = useTranslations("Admin");
  const uiLocale = useLocale();
  const uid = useId();
  const [state, action, pending] = useActionState(setSubscriptionAction, initialState);
  const [values, setValues] = useState<Partial<Record<PlanMetric, string>>>(() =>
    Object.fromEntries(PLAN_METRICS.flatMap((m) => (organization.limits_override?.[m] === undefined ? [] : [[m, String(organization.limits_override[m])]]))),
  );

  useEffect(() => {
    if (state.status === "success") toast.success(t("form.saved"));
    if (state.status === "error") toast.error(t(`errors.${state.code ?? "generic"}`));
  }, [state, t]);

  return (
    <form action={action} className="bg-muted/40 grid gap-4 rounded-lg border p-4">
      <input type="hidden" name="uiLocale" value={uiLocale} />
      <input type="hidden" name="target_organization_id" value={organization.organization_id} />
      <input type="hidden" name="limits_override" value={overrideJson(values)} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${uid}-plan`}>{t("form.plan")}</Label>
          <Select name="plan_code" defaultValue={organization.plan_code ?? "trial"} required>
            <SelectTrigger id={`${uid}-plan`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLAN_CODES.map((code) => (
                <SelectItem key={code} value={code}>
                  {t(`plans.${code}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${uid}-status`}>{t("form.status")}</Label>
          <Select name="status" defaultValue={organization.sub_status ?? "trial"} required>
            <SelectTrigger id={`${uid}-status`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUBSCRIPTION_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {t(`status.${status}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">{t("form.overrides")}</legend>
        <p className="text-muted-foreground text-xs">{t("form.overridesHint")}</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {PLAN_METRICS.map((metric) => (
            <div key={metric} className="grid gap-1">
              <Label htmlFor={`${uid}-${metric}`} className="text-xs font-normal">
                {t(`metrics.${metric}`)}
              </Label>
              <Input
                id={`${uid}-${metric}`}
                type="number"
                min={0}
                max={999999999999}
                inputMode="numeric"
                value={values[metric] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [metric]: e.target.value }))}
              />
            </div>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${uid}-end`}>{t("form.periodEnd")}</Label>
          <Input id={`${uid}-end`} name="period_end" type="date" defaultValue="" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${uid}-reason`}>{t("form.reason")}</Label>
          <Input id={`${uid}-reason`} name="reason" required minLength={3} maxLength={200} autoComplete="off" aria-describedby={`${uid}-reason-hint`} />
          <p id={`${uid}-reason-hint`} className="text-muted-foreground text-xs">
            {t("form.reasonHint")}
          </p>
        </div>
      </div>

      <div role="status" aria-live="polite" className="empty:hidden">
        {state.status === "error" ? <p className="text-destructive-text text-sm">{t(`errors.${state.code ?? "generic"}`)}</p> : null}
      </div>
      <Button type="submit" className="w-fit" disabled={pending}>
        {pending ? t("form.saving") : t("form.save")}
      </Button>
    </form>
  );
}
