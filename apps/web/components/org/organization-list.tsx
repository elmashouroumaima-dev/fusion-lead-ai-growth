"use client";

import type { OrgStatus, TenantRole } from "@fusion-leap/domain";
import { ArrowRightIcon, Building2Icon, CircleAlertIcon, LoaderCircleIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";
import { alertVariants } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { switchOrganizationAction } from "../../lib/tenant/actions";
import type { TenantActionState } from "../../lib/tenant/types";

export type OrganizationListItem = {
  id: string;
  name: string;
  role: TenantRole;
  status: OrgStatus;
};

const initialState: TenantActionState = { status: "idle" };

/** Liste de mes organisations actives ; chaque ligne est un formulaire qui change l'organisation active. */
export function OrganizationList({ items, currentId }: { items: readonly OrganizationListItem[]; currentId?: string | undefined }) {
  const t = useTranslations("Org");
  const tc = useTranslations("Common");
  const uiLocale = useLocale();
  const [state, formAction, pending] = useActionState(switchOrganizationAction, initialState);
  const errorText = state.status === "error" ? t(`errors.${state.code ?? "generic"}`) : "";

  return (
    <>
      <ul aria-label={t("select.listLabel")} className="grid gap-3">
        {items.map((item) => {
          const active = item.status === "active";
          return (
            <li key={item.id} className="bg-background flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-md"
                  aria-hidden="true"
                >
                  <Building2Icon className="size-4" />
                </span>
                <div className="grid min-w-0 gap-1.5">
                  <bdi className="font-semibold [overflow-wrap:anywhere]">{item.name}</bdi>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="secondary">{t(`roles.${item.role}`)}</Badge>
                    {!active ? <Badge variant="warning">{t("select.inactive")}</Badge> : null}
                    {item.id === currentId ? <Badge variant="success">{t("select.current")}</Badge> : null}
                  </span>
                </div>
              </div>
              <form action={formAction}>
                <input type="hidden" name="uiLocale" value={uiLocale} />
                <input type="hidden" name="organization_id" value={item.id} />
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  disabled={pending || !active}
                  aria-label={t("select.openNamed", { name: item.name })}
                >
                  {pending ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : null}
                  {pending ? tc("submitting") : t("select.open")}
                  {pending ? null : <ArrowRightIcon className="rtl:-scale-x-100" aria-hidden="true" />}
                </Button>
              </form>
            </li>
          );
        })}
      </ul>
      <div role="alert" aria-live="assertive" className={cn(errorText ? alertVariants({ variant: "destructive" }) : "sr-only")}>
        {errorText ? (
          <>
            <CircleAlertIcon aria-hidden="true" />
            <span className="col-start-2">{errorText}</span>
          </>
        ) : null}
      </div>
    </>
  );
}
