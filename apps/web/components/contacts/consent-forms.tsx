"use client";

import { CHANNEL_TYPES } from "@fusion-leap/domain";
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useEffect, useId } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { recordConsentAction, revokeConsentAction, setDoNotContactAction } from "../../lib/contacts/actions";
import { ALL_PURPOSES, CONSENT_PURPOSES, CONSENT_SOURCES } from "../../lib/contacts/consent-options";
import type { ContactsActionState } from "../../lib/contacts/types";

/**
 * Formulaires de l'écran Contact (J30b) : enregistrer un consentement, en retirer un, poser ou lever « ne plus contacter ».
 * Chaque formulaire porte l'organisation (comparée au contexte vérifié côté serveur) et une clé d'idempotence générée par le
 * serveur à chaque rendu. Le serveur revalide tout : rôle, entrée, appartenance du contact à l'entreprise.
 */

const initialState: ContactsActionState = { status: "idle" };

type Common = { contactId: string; organizationId: string; idempotencyKey: string };

/** Notification de succès et message d'erreur (zone annoncée aux lecteurs d'écran). */
function useFormFeedback(state: ContactsActionState) {
  const t = useTranslations("Contacts");
  useEffect(() => {
    if (state.status === "success" && state.success) toast.success(t(`success.${state.success}`));
  }, [state, t]);
  return state.status === "error" ? t(`errors.${state.code ?? "generic"}`) : "";
}

function Hidden({ contactId, organizationId, idempotencyKey }: Common) {
  const uiLocale = useLocale();
  return (
    <>
      <input type="hidden" name="uiLocale" value={uiLocale} />
      <input type="hidden" name="organization_id" value={organizationId} />
      <input type="hidden" name="contact_id" value={contactId} />
      <input type="hidden" name="idempotency_key" value={idempotencyKey} />
    </>
  );
}

function ChannelSelect({ id, name, hasEmail, hasPhone }: { id: string; name: string; hasEmail: boolean; hasPhone: boolean }) {
  const t = useTranslations("Contacts");
  const firstAvailable = hasEmail ? "email" : hasPhone ? "whatsapp" : "email";
  return (
    <Select name={name} defaultValue={firstAvailable}>
      <SelectTrigger id={id} className="w-full sm:w-64">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {CHANNEL_TYPES.map((channel) => (
          <SelectItem key={channel} value={channel}>
            {t(`channels.${channel}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function RecordConsentForm({ contactId, organizationId, idempotencyKey, hasEmail, hasPhone }: Common & { hasEmail: boolean; hasPhone: boolean }) {
  const t = useTranslations("Contacts");
  const uid = useId();
  const [state, formAction, pending] = useActionState(recordConsentAction, initialState);
  const error = useFormFeedback(state);

  return (
    <form action={formAction} className="grid gap-4">
      <Hidden contactId={contactId} organizationId={organizationId} idempotencyKey={idempotencyKey} />
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`${uid}-channel`}>{t("record.channel")}</Label>
          <ChannelSelect id={`${uid}-channel`} name="channel" hasEmail={hasEmail} hasPhone={hasPhone} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${uid}-purpose`}>{t("record.purpose")}</Label>
          <Select name="purpose" defaultValue={CONSENT_PURPOSES[0]}>
            <SelectTrigger id={`${uid}-purpose`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONSENT_PURPOSES.map((purpose) => (
                <SelectItem key={purpose} value={purpose}>
                  {t(`purposes.${purpose}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${uid}-source`}>{t("record.source")}</Label>
          <Select name="source" defaultValue={CONSENT_SOURCES[0]}>
            <SelectTrigger id={`${uid}-source`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONSENT_SOURCES.map((source) => (
                <SelectItem key={source} value={source}>
                  {t(`sources.${source}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {!hasEmail ? <p className="text-muted-foreground text-xs">{t("record.needEmail")}</p> : null}
      {!hasPhone ? <p className="text-muted-foreground text-xs">{t("record.needPhone")}</p> : null}
      <div className="grid gap-1.5">
        <Label htmlFor={`${uid}-text`}>{t("record.text")}</Label>
        <Textarea id={`${uid}-text`} name="consent_text" rows={3} maxLength={2000} aria-describedby={`${uid}-text-hint`} />
        <p id={`${uid}-text-hint`} className="text-muted-foreground text-xs">
          {t("record.textHint")}
        </p>
      </div>
      <div className="grid gap-1.5 sm:max-w-xs">
        <Label htmlFor={`${uid}-version`}>{t("record.version")}</Label>
        <Input id={`${uid}-version`} name="consent_version" maxLength={50} dir="ltr" aria-describedby={`${uid}-version-hint`} />
        <p id={`${uid}-version-hint`} className="text-muted-foreground text-xs">
          {t("record.versionHint")}
        </p>
      </div>
      <div role="status" aria-live="polite" className="empty:hidden">
        {error ? <p className="text-destructive-text text-sm">{error}</p> : null}
      </div>
      <Button type="submit" className="w-fit" disabled={pending}>
        {pending ? t("record.saving") : t("record.submit")}
      </Button>
    </form>
  );
}

export function RevokeConsentForm({ contactId, organizationId, idempotencyKey, hasEmail, hasPhone }: Common & { hasEmail: boolean; hasPhone: boolean }) {
  const t = useTranslations("Contacts");
  const uid = useId();
  const [state, formAction, pending] = useActionState(revokeConsentAction, initialState);
  const error = useFormFeedback(state);

  return (
    <form action={formAction} className="grid gap-4">
      <Hidden contactId={contactId} organizationId={organizationId} idempotencyKey={idempotencyKey} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${uid}-channel`}>{t("revoke.channel")}</Label>
          <ChannelSelect id={`${uid}-channel`} name="channel" hasEmail={hasEmail} hasPhone={hasPhone} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${uid}-purpose`}>{t("revoke.purpose")}</Label>
          {/* Valeur vide = toutes les finalités du canal. */}
          <Select name="purpose" defaultValue={ALL_PURPOSES}>
            <SelectTrigger id={`${uid}-purpose`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PURPOSES}>{t("revoke.allPurposes")}</SelectItem>
              {CONSENT_PURPOSES.map((purpose) => (
                <SelectItem key={purpose} value={purpose}>
                  {t(`purposes.${purpose}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="do_not_contact" className="accent-primary mt-1 size-4" />
        <span>{t("revoke.alsoBlock")}</span>
      </label>
      <div role="status" aria-live="polite" className="empty:hidden">
        {error ? <p className="text-destructive-text text-sm">{error}</p> : null}
      </div>
      <Button type="submit" variant="outline" className="w-fit" disabled={pending}>
        {pending ? t("revoke.saving") : t("revoke.submit")}
      </Button>
    </form>
  );
}

export function DoNotContactForm({ contactId, organizationId, idempotencyKey, blocked, canClear }: Common & { blocked: boolean; canClear: boolean }) {
  const t = useTranslations("Contacts");
  const [state, formAction, pending] = useActionState(setDoNotContactAction, initialState);
  const error = useFormFeedback(state);
  // Lever le blocage est réservé à owner et admin (la base le revérifie) : on n'offre pas un bouton voué au refus.
  const showButton = !blocked || canClear;

  return (
    <form action={formAction} className="grid gap-3">
      <Hidden contactId={contactId} organizationId={organizationId} idempotencyKey={idempotencyKey} />
      <input type="hidden" name="value" value={blocked ? "false" : "true"} />
      <p className="text-muted-foreground text-sm">{blocked ? t("block.descriptionOn") : t("block.descriptionOff")}</p>
      <div role="status" aria-live="polite" className="empty:hidden">
        {error ? <p className="text-destructive-text text-sm">{error}</p> : null}
      </div>
      {showButton ? (
        <Button type="submit" variant={blocked ? "outline" : "destructive"} className="w-fit" disabled={pending}>
          {pending ? t("block.saving") : blocked ? t("block.clear") : t("block.set")}
        </Button>
      ) : null}
    </form>
  );
}
