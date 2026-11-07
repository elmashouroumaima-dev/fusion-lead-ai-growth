"use client";

import { MAILTRAP_PRESET, SMTP_SECURITIES, type SmtpSettingsView } from "@fusion-leap/domain";
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { resetSmtpAction, saveSmtpAction, testSmtpAction } from "../../lib/smtp/actions";
import type { SmtpActionState } from "../../lib/smtp/types";

type Props = {
  /** Paramètres enregistrés (sans mot de passe), ou null. */
  initial: SmtpSettingsView | null;
  /** Clé maître de chiffrement configurée côté serveur : sinon le mot de passe ne peut pas être enregistré. */
  secretsAvailable: boolean;
};

const initialState: SmtpActionState = { status: "idle" };

/**
 * Paramètres SMTP de la plateforme (administrateurs de la plateforme). Le mot de passe est en écriture seule : il
 * n'est jamais renvoyé par le serveur (on voit seulement « enregistré »). Préréglage Mailtrap en un clic.
 */
export function SmtpCard({ initial, secretsAvailable }: Props) {
  const t = useTranslations("Settings.smtp");
  const te = useTranslations("Settings.smtp.errors");
  const uiLocale = useLocale();
  const uid = useId();
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(String(initial?.port ?? ""));
  const [security, setSecurity] = useState<string>(initial?.security ?? "starttls");
  const [fromEmail, setFromEmail] = useState(initial?.from_email ?? "");
  const [fromName, setFromName] = useState(initial?.from_name ?? "");
  const [saveState, saveAction, saving] = useActionState(saveSmtpAction, initialState);
  const [resetState, resetAction, resetting] = useActionState(resetSmtpAction, initialState);
  const [testState, testAction, testing] = useActionState(testSmtpAction, initialState);

  useEffect(() => {
    if (saveState.status === "success") toast.success(t("saved"));
    if (saveState.status === "error") toast.error(te(saveState.code ?? "generic"));
  }, [saveState, t, te]);
  useEffect(() => {
    if (resetState.status === "success") toast.success(t("resetDone"));
    if (resetState.status === "error") toast.error(te(resetState.code ?? "generic"));
  }, [resetState, t, te]);
  useEffect(() => {
    if (testState.status === "success") toast.success(t("testSent"));
    if (testState.status === "error") toast.error(te(testState.code ?? "generic"));
  }, [testState, t, te]);

  const applyMailtrap = () => {
    setHost(MAILTRAP_PRESET.host);
    setPort(String(MAILTRAP_PRESET.port));
    setSecurity(MAILTRAP_PRESET.security);
    // Mailtrap accepte n'importe quel expéditeur : valeurs par défaut si les champs sont vides.
    setFromEmail((v) => (v.trim() === "" ? MAILTRAP_PRESET.from_email : v));
    setFromName((v) => (v.trim() === "" ? MAILTRAP_PRESET.from_name : v));
  };

  const lastError = [saveState, resetState, testState].find((s) => s.status === "error");

  return (
    <div className="grid gap-4">
        {!secretsAvailable ? (
          <Alert role="status">
            <p className="text-sm">{t("noKey")}</p>
          </Alert>
        ) : null}

        <div>
          <Button type="button" variant="outline" size="sm" onClick={applyMailtrap}>
            {t("mailtrap")}
          </Button>
          <p className="text-muted-foreground mt-1 text-xs">{t("mailtrapHint")}</p>
        </div>

        <form action={saveAction} className="grid gap-4">
          <input type="hidden" name="uiLocale" value={uiLocale} />
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor={`${uid}-host`}>{t("host")}</Label>
              <Input id={`${uid}-host`} name="host" required dir="ltr" autoComplete="off" spellCheck={false} value={host} onChange={(e) => setHost(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${uid}-port`}>{t("port")}</Label>
              <Input id={`${uid}-port`} name="port" required type="number" min={1} max={65535} inputMode="numeric" dir="ltr" value={port} onChange={(e) => setPort(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={`${uid}-security`}>{t("security")}</Label>
              <Select name="security" value={security} onValueChange={setSecurity} required>
                <SelectTrigger id={`${uid}-security`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SMTP_SECURITIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`securities.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${uid}-user`}>{t("username")}</Label>
              <Input id={`${uid}-user`} name="username" dir="ltr" autoComplete="off" defaultValue={initial?.username ?? ""} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${uid}-password`}>{t("password")}</Label>
            <Input
              id={`${uid}-password`}
              name="password"
              type="password"
              dir="ltr"
              autoComplete="new-password"
              placeholder={initial?.has_password ? "••••••••" : ""}
              disabled={!secretsAvailable}
              aria-describedby={`${uid}-password-hint`}
            />
            <p id={`${uid}-password-hint`} className="text-muted-foreground text-xs">
              {initial?.has_password ? t("passwordSaved") : t("passwordHint")}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={`${uid}-from`}>{t("fromEmail")}</Label>
              <Input id={`${uid}-from`} name="from_email" type="email" required dir="ltr" autoComplete="off" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${uid}-fromname`}>{t("fromName")}</Label>
              <Input id={`${uid}-fromname`} name="from_name" maxLength={100} autoComplete="off" value={fromName} onChange={(e) => setFromName(e.target.value)} />
            </div>
          </div>
          <Button type="submit" className="w-fit" disabled={saving}>
            {saving ? t("saving") : t("save")}
          </Button>
        </form>

        <div role="status" aria-live="polite" className="empty:hidden">
          {lastError ? <p className="text-destructive-text text-sm">{te(lastError.code ?? "generic")}</p> : null}
        </div>

        <div className="flex flex-wrap gap-3 border-t pt-4">
          <form action={testAction}>
            <input type="hidden" name="uiLocale" value={uiLocale} />
            <Button type="submit" variant="secondary" disabled={testing || !initial}>
              {testing ? t("testing") : t("test")}
            </Button>
          </form>
          <form action={resetAction}>
            <input type="hidden" name="uiLocale" value={uiLocale} />
            <Button type="submit" variant="outline" disabled={resetting || !initial}>
              {t("reset")}
            </Button>
          </form>
        </div>
        <p className="text-muted-foreground text-xs">{t("testHint")}</p>
    </div>
  );
}
