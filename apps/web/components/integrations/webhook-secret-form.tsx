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
  /** Adresse du webhook à donner au fournisseur (déjà calculée côté serveur à partir de `SITE_URL`). */
  webhookUrl: string;
  /** Le secret est CHOISI par nous (Kapso, Postmark, Meta : bouton « Générer ») ou donné par le fournisseur (Resend : à coller). */
  canGenerate: boolean;
};

type Notice = { text: string; error: boolean } | null;

/** Secret aléatoire (64 caractères hexadécimaux), généré dans le navigateur : il n'est envoyé qu'à l'enregistrement et n'est pas conservé. */
const randomSecret = (): string => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Remplacer le secret de WEBHOOK d'une intégration existante (écriture seule : jamais relu, vidé dès l'envoi). Sert quand le secret chez le fournisseur et celui de
 * l'application ne correspondent plus (les événements sont alors refusés « signature invalide »). Le secret reste distinct du jeton d'envoi (contrôlé par le
 * serveur). Chaque envoi porte une clé d'idempotence neuve ; le secret n'est conservé ni dans un état, ni dans une URL.
 */
export function WebhookSecretForm({ integrationId, encryptionConfigured, webhookUrl, canGenerate }: Props) {
  const t = useTranslations("Integrations.webhookSecret");
  const router = useRouter();
  const field = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const inputId = `webhook-secret-${integrationId}`;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const input = field.current;
    if (busy || !input || input.value === "") return;
    const secret = input.value;
    setBusy(true);
    try {
      const response = await fetch("/api/integrations/webhook-secret", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ integration_id: integrationId, secret }),
      });
      input.value = "";
      if (response.ok) {
        setNotice({ text: t("done"), error: false });
        toast.success(t("done"));
        router.refresh();
      } else if (response.status === 400) {
        setNotice({ text: t("invalid"), error: true });
      } else if (response.status === 503) {
        setNotice({ text: t("unavailable"), error: true });
      } else {
        setNotice({ text: t("failed"), error: true });
        toast.error(t("failed"));
      }
    } catch {
      input.value = "";
      setNotice({ text: t("failed"), error: true });
    } finally {
      setBusy(false);
    }
  }

  const off = !encryptionConfigured || busy;
  return (
    <form onSubmit={submit} className="grid gap-2" autoComplete="off">
      <Label htmlFor={inputId}>{t("label")}</Label>
      <div className="flex flex-wrap gap-2">
        <Input
          id={inputId}
          ref={field}
          type={canGenerate ? "text" : "password"}
          dir="ltr"
          className="max-w-md font-mono"
          disabled={off}
          autoComplete={canGenerate ? "off" : "new-password"}
          spellCheck={false}
          aria-describedby={`${inputId}-hint`}
        />
        {canGenerate ? (
          <Button
            type="button"
            variant="outline"
            disabled={off}
            onClick={() => {
              if (field.current) field.current.value = randomSecret();
            }}
          >
            {t("generate")}
          </Button>
        ) : null}
        <Button type="submit" disabled={off}>
          {t("submit")}
        </Button>
      </div>
      <p id={`${inputId}-hint`} className="text-muted-foreground text-xs">
        {canGenerate ? t("hintOwn") : t("hintProvider")}
      </p>
      <p className="text-sm">
        <span className="font-semibold">{t("urlLabel")}</span>{" "}
        <bdi dir="ltr" className="text-muted-foreground font-mono text-xs break-all">
          {webhookUrl}
        </bdi>
      </p>
      <p role="status" aria-live="polite" className={notice?.error ? "text-destructive-text text-sm" : "text-muted-foreground text-sm"}>
        {notice?.text ?? ""}
      </p>
    </form>
  );
}
