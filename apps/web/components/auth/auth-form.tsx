"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState, useId } from "react";
import type { AuthActionState, AuthErrorCode } from "../../lib/auth/types";
import type { InitialErrorCode } from "./initial-error";

export type AuthAction = (prevState: AuthActionState, formData: FormData) => Promise<AuthActionState>;

export type AuthField = {
  /** Nom du champ de formulaire attendu par l'action (zod côté A2). */
  name: "email" | "password";
  /** Clé de libellé dans Auth.fields. */
  label: "email" | "password" | "newPassword";
  type: "email" | "password";
  autoComplete: "email" | "current-password" | "new-password";
  showPasswordHint?: boolean;
};

type Props = {
  action: AuthAction;
  fields: AuthField[];
  submitLabel: string;
  /** Message de succès traduit ; absent si l'action redirige. */
  successMessage?: string;
  next?: string | undefined;
  /** Erreur affichée avant toute soumission (ex. lien de confirmation invalide). */
  initialErrorCode?: InitialErrorCode | undefined;
};

const initialState: AuthActionState = { status: "idle" };

export function AuthForm({ action, fields, submitLabel, successMessage, next, initialErrorCode }: Props) {
  const t = useTranslations("Auth");
  const tc = useTranslations("Common");
  const locale = useLocale();
  const uid = useId();
  const [state, formAction, pending] = useActionState(action, initialState);

  const errorCode: AuthErrorCode | InitialErrorCode | undefined =
    state.status === "error" ? (state.code ?? "generic") : state.status === "idle" ? initialErrorCode : undefined;
  const errorText = errorCode ? t(`errors.${errorCode}`) : "";
  const successText = state.status === "success" ? (successMessage ?? "") : "";

  return (
    <form action={formAction} className="form">
      <input type="hidden" name="locale" value={locale} />
      {next ? <input type="hidden" name="next" value={next} /> : null}

      {fields.map((field) => {
        const id = `${uid}-${field.name}`;
        const hintId = `${id}-hint`;
        const invalid = Boolean(state.fieldErrors?.[field.name]?.length);
        return (
          <div className="field" key={field.name}>
            <label htmlFor={id}>{t(`fields.${field.label}`)}</label>
            <input
              id={id}
              name={field.name}
              type={field.type}
              autoComplete={field.autoComplete}
              required
              aria-invalid={invalid}
              aria-describedby={field.showPasswordHint ? hintId : undefined}
              {...(field.type === "email" ? { inputMode: "email" as const, dir: "ltr" as const } : {})}
            />
            {field.showPasswordHint ? (
              <span className="hint" id={hintId}>
                {t("hints.passwordMin")}
              </span>
            ) : null}
          </div>
        );
      })}

      <div aria-live="polite" role="status">
        <p className="notice notice-error" hidden={!errorText}>
          {errorText}
        </p>
        <p className="notice notice-success" hidden={!successText}>
          {successText}
        </p>
      </div>

      <button className="btn" type="submit" disabled={pending}>
        {pending ? tc("submitting") : submitLabel}
      </button>
    </form>
  );
}
