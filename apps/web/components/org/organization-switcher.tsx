"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState, useId } from "react";
import { switchOrganizationAction } from "../../lib/tenant/actions";
import type { TenantActionState } from "../../lib/tenant/types";
import styles from "./organization.module.css";

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
  const [state, formAction, pending] = useActionState(switchOrganizationAction, initialState);
  const errorText = state.status === "error" ? t(`errors.${state.code ?? "generic"}`) : "";

  return (
    <form action={formAction} className={styles.switcherForm}>
      <input type="hidden" name="uiLocale" value={uiLocale} />
      <label className={styles.switcherLabel} htmlFor={`${uid}-org`}>
        {t("switcher.label")}
      </label>
      <select
        id={`${uid}-org`}
        name="organization_id"
        className={styles.select}
        defaultValue={selectedId ?? options[0]?.id}
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
      <button className="btn btn-secondary" type="submit" disabled={pending}>
        {t("switcher.submit")}
      </button>
      <span aria-live="polite" role="status">
        {errorText ? <span className="notice notice-error">{errorText}</span> : null}
      </span>
    </form>
  );
}
