"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState, useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { switchOrganizationAction } from "../../lib/tenant/actions";
import type { TenantActionState } from "../../lib/tenant/types";

type Props = {
  options: readonly { id: string; name: string }[];
  /** Organisation affichée comme sélectionnée (indice d'affichage seulement ; l'autorisation est revérifiée côté serveur). */
  selectedId?: string | undefined;
};

const initialState: TenantActionState = { status: "idle" };

/** Sélecteur d'organisation de l'en-tête, affiché quand l'utilisateur a au moins deux adhésions actives. */
export function OrganizationSwitcher({ options, selectedId }: Props) {
  const t = useTranslations("Org");
  const uiLocale = useLocale();
  const uid = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState(switchOrganizationAction, initialState);
  const errorText = state.status === "error" ? t(`errors.${state.code ?? "generic"}`) : "";
  const errorId = `${uid}-error`;

  return (
    <form ref={formRef} action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="uiLocale" value={uiLocale} />
      <Label htmlFor={`${uid}-org`} className="sr-only">
        {t("switcher.label")}
      </Label>
      <Select
        name="organization_id"
        defaultValue={selectedId ?? options[0]?.id}
        // Changer de valeur change d'organisation tout de suite : sans cela le menu affiche une organisation qui n'est pas
        // encore la bonne tant qu'on n'a pas cliqué sur le bouton. Le serveur revérifie l'adhésion à chaque requête.
        onValueChange={(next) => {
          if (next !== selectedId) setTimeout(() => formRef.current?.requestSubmit(), 0);
        }}
      >
        <SelectTrigger
          id={`${uid}-org`}
          size="sm"
          className="max-w-40 sm:max-w-56"
          aria-describedby={errorText ? errorId : undefined}
          aria-invalid={errorText ? true : undefined}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              <bdi>{option.name}</bdi>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button type="submit" variant="outline" size="sm" disabled={pending} className="sr-only">
        {t("switcher.submit")}
      </Button>
      <span aria-live="polite" role="status" id={errorId} className={errorText ? "text-destructive-text max-w-48 text-xs" : "sr-only"}>
        {errorText}
      </span>
    </form>
  );
}
