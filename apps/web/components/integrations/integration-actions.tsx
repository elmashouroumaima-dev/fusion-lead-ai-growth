"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Props = {
  integrationId: string;
  /** Le chiffrement des secrets est-il configuré sur le serveur ? Sinon le remplacement est désactivé. */
  encryptionConfigured: boolean;
  /** Une intégration déconnectée se reconnecte en enregistrant un nouveau jeton (le bouton « Déconnecter » disparaît). */
  disconnected: boolean;
};

type Notice = { text: string; error: boolean } | null;

/**
 * Actions d'une intégration à jeton : « Remplacer le jeton » (champ en ÉCRITURE SEULE, jamais pré-rempli ni relu) et « Déconnecter »
 * (confirmation en deux temps). Le jeton ne vit que dans le champ, le temps de l'envoi : il est vidé juste après, et n'est jamais
 * conservé dans un état, une URL ou un journal du navigateur. Chaque envoi porte une clé d'idempotence neuve.
 */
export function IntegrationActions({ integrationId, encryptionConfigured, disconnected }: Props) {
  const t = useTranslations("Integrations");
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  async function post(path: string, payload: Record<string, unknown>): Promise<Response> {
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify(payload),
    });
  }

  async function replace(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const field = input.current;
    if (busy || !field || field.value === "") return;
    setBusy(true);
    try {
      const response = await post("/api/integrations/secret", { integration_id: integrationId, secret: field.value });
      field.value = "";
      if (response.ok) {
        setNotice({ text: t("replace.done"), error: false });
        toast.success(t("replace.done"));
        router.refresh();
      } else if (response.status === 503) {
        setNotice({ text: t("replace.unavailable"), error: true });
      } else if (response.status === 400) {
        setNotice({ text: t("replace.invalid"), error: true });
      } else {
        setNotice({ text: t("replace.failed"), error: true });
        toast.error(t("replace.failed"));
      }
    } catch {
      field.value = "";
      setNotice({ text: t("replace.failed"), error: true });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const response = await post("/api/integrations/disconnect", { integration_id: integrationId });
      if (response.ok) {
        setNotice({ text: t("disconnect.done"), error: false });
        toast.success(t("disconnect.done"));
        setConfirming(false);
        router.refresh();
      } else {
        setNotice({ text: t("disconnect.failed"), error: true });
        toast.error(t("disconnect.failed"));
      }
    } catch {
      setNotice({ text: t("disconnect.failed"), error: true });
    } finally {
      setBusy(false);
    }
  }

  const inputId = `secret-${integrationId}`;

  return (
    <div className="grid gap-4">
      <form onSubmit={replace} className="grid gap-2" autoComplete="off">
        <Label htmlFor={inputId}>{t("replace.label")}</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id={inputId}
            ref={input}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            disabled={!encryptionConfigured || busy}
            aria-describedby={`${inputId}-hint`}
            dir="ltr"
          />
          <Button type="submit" disabled={!encryptionConfigured || busy}>
            {disconnected ? t("replace.reconnect") : t("replace.submit")}
          </Button>
        </div>
        <p id={`${inputId}-hint`} className="text-muted-foreground text-xs">
          {t("replace.hint")}
        </p>
      </form>

      <div className="grid gap-2" hidden={disconnected}>
        {confirming ? (
          <div role="alertdialog" aria-label={t("disconnect.button")} className="grid gap-2 rounded-md border border-destructive/40 p-3">
            <p className="text-sm">{t("disconnect.confirm")}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="destructive" disabled={busy} onClick={() => void disconnect()}>
                {t("disconnect.confirmButton")}
              </Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
                {t("disconnect.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <Button type="button" variant="outline" className="justify-self-start" onClick={() => setConfirming(true)}>
            {t("disconnect.button")}
          </Button>
        )}
      </div>

      <p role="status" aria-live="polite" className={notice?.error ? "text-destructive-text text-sm" : "text-muted-foreground text-sm"}>
        {notice?.text ?? ""}
      </p>
    </div>
  );
}
