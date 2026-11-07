"use client";

import { DEFAULT_LOCALE, LOCALES, localeSchema } from "@fusion-leap/domain";
import { CircleAlertIcon, LoaderCircleIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useId, useState, useSyncExternalStore } from "react";
import { alertVariants } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { createOrganizationAction } from "../../lib/tenant/actions";
import type { TenantActionState } from "../../lib/tenant/types";

type Props = {
  /** Clé d'idempotence générée côté serveur à chaque rendu : un rejeu du même envoi ne crée pas de doublon. */
  creationKey: string;
  /** Noms IANA (calculés côté serveur depuis @fusion-leap/domain). */
  timeZones: readonly string[];
};

const initialState: TenantActionState = { status: "idle" };

const subscribeNever = () => () => undefined;

function detectBrowserZone(timeZones: readonly string[]): string {
  try {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (detected && timeZones.includes(detected)) return detected;
  } catch {
    // Fuseau indisponible : on garde UTC.
  }
  return "UTC";
}

export function CreateOrganizationForm({ creationKey, timeZones }: Props) {
  const t = useTranslations("Org");
  const tc = useTranslations("Common");
  const uiLocale = useLocale();
  const defaultLocale = localeSchema.safeParse(uiLocale).data ?? DEFAULT_LOCALE;
  const uid = useId();
  const [state, formAction, pending] = useActionState(createOrganizationAction, initialState);
  const [chosenZone, setChosenZone] = useState<string | null>(null);
  const [orgLocale, setOrgLocale] = useState<string>(defaultLocale);

  // Fuseau du navigateur s'il figure dans la liste (valeur serveur « UTC » à l'hydratation ; jamais envoyé sans validation serveur).
  const detectedZone = useSyncExternalStore(
    subscribeNever,
    () => detectBrowserZone(timeZones),
    () => "UTC",
  );
  const timezone = chosenZone ?? detectedZone;

  const errorText = state.status === "error" ? t(`errors.${state.code ?? "generic"}`) : "";
  const nameInvalid = Boolean(state.fieldErrors?.name?.length);
  const zoneInvalid = Boolean(state.fieldErrors?.timezone?.length);
  const nameId = `${uid}-name`;
  const zoneId = `${uid}-timezone`;
  const localeId = `${uid}-locale`;
  const nameErrId = `${uid}-name-error`;
  const zoneErrId = `${uid}-timezone-error`;
  const localeHintId = `${uid}-locale-hint`;
  const fieldError = "text-destructive-text text-sm font-medium";
  const shownLocale = localeSchema.safeParse(orgLocale).data ?? DEFAULT_LOCALE;

  return (
    <form action={formAction} className="grid gap-4" aria-busy={pending}>
      <input type="hidden" name="uiLocale" value={uiLocale} />
      <input type="hidden" name="creation_key" value={creationKey} />

      <div className="grid gap-2">
        <Label htmlFor={nameId}>{t("onboarding.fields.name")}</Label>
        <Input
          id={nameId}
          name="name"
          type="text"
          autoComplete="organization"
          required
          maxLength={120}
          error={nameInvalid}
          aria-describedby={nameInvalid ? nameErrId : undefined}
          className="h-10"
        />
        {nameInvalid ? (
          <p id={nameErrId} className={fieldError}>
            {t("errors.invalid_input")}
          </p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <Label htmlFor={zoneId}>{t("onboarding.fields.timezone")}</Label>
        <Select name="timezone" value={timezone} onValueChange={setChosenZone} dir="ltr">
          <SelectTrigger
            id={zoneId}
            className="h-10 w-full"
            aria-invalid={zoneInvalid}
            aria-describedby={zoneInvalid ? zoneErrId : undefined}
          >
            <SelectValue>{timezone}</SelectValue>
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {timeZones.map((zone) => (
              <SelectItem key={zone} value={zone}>
                {zone}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {zoneInvalid ? (
          <p id={zoneErrId} className={fieldError}>
            {t("errors.invalid_input")}
          </p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <Label htmlFor={localeId}>{t("onboarding.fields.locale")}</Label>
        <Select name="locale" value={orgLocale} onValueChange={setOrgLocale}>
          <SelectTrigger id={localeId} className="h-10 w-full" aria-describedby={localeHintId}>
            <SelectValue>{t(`onboarding.locales.${shownLocale}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {LOCALES.map((l) => (
              <SelectItem key={l} value={l}>
                {t(`onboarding.locales.${l}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p id={localeHintId} className="text-muted-foreground text-sm">
          {t("onboarding.hints.locale")}
        </p>
      </div>

      <div role="alert" aria-live="assertive" className={cn(errorText ? alertVariants({ variant: "destructive" }) : "sr-only")}>
        {errorText ? (
          <>
            <CircleAlertIcon aria-hidden="true" />
            <span className="col-start-2">{errorText}</span>
          </>
        ) : null}
      </div>

      <Button
        type="submit"
        size="lg"
        disabled={pending}
        className="h-11 w-full bg-linear-to-r from-primary to-secondary font-semibold text-white shadow-md hover:opacity-90 rtl:bg-linear-to-l"
      >
        {pending ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : null}
        {pending ? tc("submitting") : t("onboarding.submit")}
      </Button>
    </form>
  );
}
