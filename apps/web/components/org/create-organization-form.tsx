"use client";

import { DEFAULT_LOCALE, LOCALES, localeSchema } from "@fusion-leap/domain";
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useEffect, useId, useRef } from "react";
import { createOrganizationAction } from "../../lib/tenant/actions";
import type { TenantActionState } from "../../lib/tenant/types";
import styles from "./organization.module.css";

type Props = {
  /** Clé d'idempotence générée côté serveur à chaque rendu : un rejeu du même envoi ne crée pas de doublon. */
  creationKey: string;
  /** Noms IANA (calculés côté serveur depuis @fusion-leap/domain). */
  timeZones: readonly string[];
};

const initialState: TenantActionState = { status: "idle" };

export function CreateOrganizationForm({ creationKey, timeZones }: Props) {
  const t = useTranslations("Org");
  const tc = useTranslations("Common");
  const uiLocale = useLocale();
  const defaultLocale = localeSchema.safeParse(uiLocale).data ?? DEFAULT_LOCALE;
  const uid = useId();
  const [state, formAction, pending] = useActionState(createOrganizationAction, initialState);
  const zoneRef = useRef<HTMLSelectElement>(null);

  // Préselectionne le fuseau du navigateur s'il figure dans la liste (jamais envoyé sans validation serveur).
  useEffect(() => {
    try {
      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (detected && zoneRef.current && timeZones.includes(detected)) zoneRef.current.value = detected;
    } catch {
      // Fuseau indisponible : on garde UTC.
    }
  }, [timeZones]);

  const errorText = state.status === "error" ? t(`errors.${state.code ?? "generic"}`) : "";
  const nameInvalid = Boolean(state.fieldErrors?.name?.length);
  const zoneInvalid = Boolean(state.fieldErrors?.timezone?.length);
  const nameId = `${uid}-name`;
  const zoneId = `${uid}-timezone`;
  const localeId = `${uid}-locale`;
  const nameErrId = `${uid}-name-error`;
  const zoneErrId = `${uid}-timezone-error`;
  const localeHintId = `${uid}-locale-hint`;

  return (
    <form action={formAction} className="form">
      <input type="hidden" name="uiLocale" value={uiLocale} />
      <input type="hidden" name="creation_key" value={creationKey} />

      <div className="field">
        <label htmlFor={nameId}>{t("onboarding.fields.name")}</label>
        <input
          id={nameId}
          name="name"
          type="text"
          autoComplete="organization"
          required
          maxLength={120}
          aria-invalid={nameInvalid}
          aria-describedby={nameInvalid ? nameErrId : undefined}
        />
        {nameInvalid ? (
          <p id={nameErrId} className="notice notice-error">
            {t("errors.invalid_input")}
          </p>
        ) : null}
      </div>

      <div className="field">
        <label htmlFor={zoneId}>{t("onboarding.fields.timezone")}</label>
        <select
          id={zoneId}
          name="timezone"
          className={`${styles.select} ${styles.fieldSelect}`}
          ref={zoneRef}
          defaultValue="UTC"
          aria-invalid={zoneInvalid}
          aria-describedby={zoneInvalid ? zoneErrId : undefined}
          dir="ltr"
        >
          {timeZones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
        {zoneInvalid ? (
          <p id={zoneErrId} className="notice notice-error">
            {t("errors.invalid_input")}
          </p>
        ) : null}
      </div>

      <div className="field">
        <label htmlFor={localeId}>{t("onboarding.fields.locale")}</label>
        <select
          id={localeId}
          name="locale"
          className={`${styles.select} ${styles.fieldSelect}`}
          defaultValue={defaultLocale}
          aria-describedby={localeHintId}
        >
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {t(`onboarding.locales.${l}`)}
            </option>
          ))}
        </select>
        <span id={localeHintId} className="hint">
          {t("onboarding.hints.locale")}
        </span>
      </div>

      <div role="alert" aria-live="assertive">
        {errorText ? <p className="notice notice-error">{errorText}</p> : null}
      </div>

      <button className="btn" type="submit" disabled={pending}>
        {pending ? tc("submitting") : t("onboarding.submit")}
      </button>
    </form>
  );
}
