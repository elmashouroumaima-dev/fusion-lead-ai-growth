"use client";

import { CircleAlertIcon, CircleCheckIcon, EyeIcon, EyeOffIcon, LoaderCircleIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useId, useState, type ReactNode } from "react";
import { alertVariants } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
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
  /** Lien affiché sur la ligne du libellé du mot de passe (ex. « Mot de passe oublié ? »). */
  passwordAction?: ReactNode;
};

const initialState: AuthActionState = { status: "idle" };

function PasswordInput({
  id,
  name,
  autoComplete,
  invalid,
  describedBy,
}: {
  id: string;
  name: string;
  autoComplete: AuthField["autoComplete"];
  invalid: boolean;
  describedBy: string | undefined;
}) {
  const t = useTranslations("Auth.fields");
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        name={name}
        type={visible ? "text" : "password"}
        autoComplete={autoComplete}
        required
        error={invalid}
        aria-describedby={describedBy}
        dir="ltr"
        className="h-10 pe-11 text-start"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute end-1 top-1/2 -translate-y-1/2"
        aria-label={visible ? t("hidePassword") : t("showPassword")}
        aria-pressed={visible}
        aria-controls={id}
        onClick={() => setVisible((v) => !v)}
      >
        {visible ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
      </Button>
    </div>
  );
}

export function AuthForm({ action, fields, submitLabel, successMessage, next, initialErrorCode, passwordAction }: Props) {
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
    <form action={formAction} className="grid gap-4" aria-busy={pending}>
      <input type="hidden" name="locale" value={locale} />
      {next ? <input type="hidden" name="next" value={next} /> : null}

      {fields.map((field) => {
        const id = `${uid}-${field.name}`;
        const hintId = `${id}-hint`;
        const errorId = `${id}-error`;
        const invalid = Boolean(state.fieldErrors?.[field.name]?.length);
        const describedBy =
          [field.showPasswordHint ? hintId : null, invalid ? errorId : null].filter(Boolean).join(" ") || undefined;
        return (
          <div className="grid gap-2" key={field.name}>
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={id}>{t(`fields.${field.label}`)}</Label>
              {field.name === "password" ? passwordAction : null}
            </div>
            {field.type === "password" ? (
              <PasswordInput
                id={id}
                name={field.name}
                autoComplete={field.autoComplete}
                invalid={invalid}
                describedBy={describedBy}
              />
            ) : (
              <Input
                id={id}
                name={field.name}
                type={field.type}
                autoComplete={field.autoComplete}
                required
                error={invalid}
                aria-describedby={describedBy}
                inputMode={field.type === "email" ? "email" : undefined}
                dir={field.type === "email" ? "ltr" : undefined}
                className="h-10 text-start"
              />
            )}
            {field.showPasswordHint ? (
              <p className="text-muted-foreground text-sm" id={hintId}>
                {t("hints.passwordMin")}
              </p>
            ) : null}
            {invalid ? (
              <p id={errorId} className="text-destructive-text text-sm font-medium">
                {t("errors.invalid_input")}
              </p>
            ) : null}
          </div>
        );
      })}

      {/* Régions toujours montées (même vides) pour que les lecteurs d'écran annoncent le texte à son apparition. */}
      <div role="alert" aria-atomic="true" className={cn(errorText ? alertVariants({ variant: "destructive" }) : "sr-only")}>
        {errorText ? (
          <>
            <CircleAlertIcon aria-hidden="true" />
            <span className="col-start-2">{errorText}</span>
          </>
        ) : null}
      </div>
      <div role="status" aria-live="polite" className={cn(successText ? alertVariants({ variant: "success" }) : "sr-only")}>
        {successText ? (
          <>
            <CircleCheckIcon aria-hidden="true" />
            <span className="col-start-2">{successText}</span>
          </>
        ) : null}
      </div>

      <Button
        type="submit"
        size="lg"
        disabled={pending}
        className="h-11 w-full font-semibold"
      >
        {pending ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : null}
        {pending ? tc("submitting") : submitLabel}
      </Button>
    </form>
  );
}
