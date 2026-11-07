"use client";

import type { OrgStatus, TenantRole } from "@fusion-leap/domain";
import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";
import { switchOrganizationAction } from "../../lib/tenant/actions";
import type { TenantActionState } from "../../lib/tenant/types";
import styles from "./organization.module.css";

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
      <ul className={styles.orgList}>
        {items.map((item) => {
          const active = item.status === "active";
          return (
            <li key={item.id} className={styles.orgItem}>
              <div className={styles.orgText}>
                <span className={styles.orgName}>{item.name}</span>
                <span className={styles.orgMeta}>
                  {t(`roles.${item.role}`)}
                  {!active ? ` · ${t("select.inactive")}` : ""}
                  {item.id === currentId ? ` · ${t("select.current")}` : ""}
                </span>
              </div>
              <form action={formAction}>
                <input type="hidden" name="uiLocale" value={uiLocale} />
                <input type="hidden" name="organization_id" value={item.id} />
                <button
                  className="btn btn-secondary"
                  type="submit"
                  disabled={pending || !active}
                  aria-label={t("select.openNamed", { name: item.name })}
                >
                  {pending ? tc("submitting") : t("select.open")}
                </button>
              </form>
            </li>
          );
        })}
      </ul>
      <div role="alert" aria-live="assertive">
        {errorText ? <p className="notice notice-error">{errorText}</p> : null}
      </div>
    </>
  );
}
