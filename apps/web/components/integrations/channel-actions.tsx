"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Notice = { text: string; error: boolean } | null;

const post = (path: string, payload: Record<string, unknown>): Promise<Response> =>
  fetch(path, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(payload) });

/** Identifiant de compte d'une intégration e-mail : dérivé du domaine de l'expéditeur (caractères permis par le schéma serveur). */
export type EmailProviderChoice = "postmark" | "resend";
export const emailAccountId = (sender: string, provider: EmailProviderChoice = "postmark"): string =>
  `${provider}-${sender
    .slice(sender.lastIndexOf("@") + 1)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")}`.slice(0, 100);

function verifyText(t: ReturnType<typeof useTranslations>, body: { status?: string; code?: string } | null): string {
  if (body?.status === "active") return t("channelsUi.verify.ok");
  if (body?.code === "provider_auth") return t("channelsUi.verify.auth");
  return t("channelsUi.verify.unreadable");
}

/**
 * Connecter un e-mail Postmark ou Resend (écran de canaux) : adresse d'expéditeur + jeton du serveur Postmark ou clé d'API Resend (écriture seule, vidé dès l'envoi). Trois appels
 * dans l'ordre : intégration (jeton chiffré côté serveur), canal e-mail, vérification auprès de Postmark (le canal devient actif si elle réussit).
 */
export function ConnectEmail({ encryptionConfigured, resendWebhookUrl }: { encryptionConfigured: boolean; resendWebhookUrl: string }) {
  const t = useTranslations("Integrations");
  const router = useRouter();
  const sender = useRef<HTMLInputElement>(null);
  const token = useRef<HTMLInputElement>(null);
  const hookSecret = useRef<HTMLInputElement>(null);
  const [provider, setProvider] = useState<EmailProviderChoice>("postmark");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  async function connect(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const senderField = sender.current;
    const tokenField = token.current;
    if (busy || !senderField || !tokenField || !senderField.value || !tokenField.value) return;
    const hookField = hookSecret.current;
    // Resend : le secret de signature du webhook est obligatoire (sans lui, aucun statut de livraison ne serait authentifié)
    if (provider === "resend" && (!hookField || !hookField.value)) return;
    const values = { sender: senderField.value.trim(), token: tokenField.value, hook: hookField?.value ?? "" };
    tokenField.value = "";
    if (hookField) hookField.value = "";
    setBusy(true);
    try {
      const created = await post("/api/integrations", {
        provider: "email", external_account_id: emailAccountId(values.sender, provider), scopes: [], secret: values.token,
        // Postmark = comportement par défaut (`meta`) ; Resend = passerelle `resend` (ADR 008, note du 2026-11-23)
        ...(provider === "resend" ? { gateway: "resend" } : {}),
      });
      if (created.status === 409) {
        setNotice({ text: t("channelsUi.email.duplicate"), error: true });
        return;
      }
      if (!created.ok) {
        setNotice({ text: created.status === 400 ? t("channelsUi.email.invalid") : t("channelsUi.failed"), error: true });
        return;
      }
      const { integration } = (await created.json()) as { integration: { id: string } };
      const channel = await post("/api/channels", { integration_id: integration.id, type: "email", sender_identity: values.sender, project_scope: [] });
      if (!channel.ok) {
        setNotice({ text: channel.status === 400 ? t("channelsUi.email.invalid") : channel.status === 409 ? t("channelsUi.email.duplicate") : t("channelsUi.failed"), error: true });
        router.refresh();
        return;
      }
      if (provider === "resend") {
        const hook = await post("/api/integrations/webhook-secret", { integration_id: integration.id, secret: values.hook });
        if (!hook.ok) {
          setNotice({ text: hook.status === 400 ? t("channelsUi.email.webhookSecretInvalid") : t("channelsUi.failed"), error: true });
          router.refresh();
          return;
        }
      }
      const verified = await post("/api/integrations/validate", { integration_id: integration.id });
      const body = verified.ok ? ((await verified.json()) as { status?: string; code?: string }) : null;
      setNotice({ text: verified.ok ? verifyText(t, body) : t("channelsUi.verify.unavailable"), error: body?.status !== "active" });
      if (body?.status === "active") {
        senderField.value = "";
        toast.success(t("channelsUi.verify.ok"));
      }
      router.refresh();
    } catch {
      setNotice({ text: t("channelsUi.failed"), error: true });
    } finally {
      setBusy(false);
    }
  }

  const off = !encryptionConfigured || busy;
  return (
    <form onSubmit={connect} className="grid gap-3 rounded-lg border p-4" autoComplete="off">
      <h2 className="text-lg leading-none font-semibold">{t("channelsUi.email.title")}</h2>
      <p className="text-muted-foreground text-sm">{t("channelsUi.email.description")}</p>
      <div className="grid gap-1">
        <Label htmlFor="em-provider">{t("channelsUi.email.provider")}</Label>
        <select
          id="em-provider" value={provider} disabled={off} onChange={(e) => setProvider(e.target.value === "resend" ? "resend" : "postmark")}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="postmark">{t("channelsUi.email.providerPostmark")}</option>
          <option value="resend">{t("channelsUi.email.providerResend")}</option>
        </select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="em-sender">{t("channelsUi.email.sender")}</Label>
        <Input id="em-sender" ref={sender} type="email" dir="ltr" disabled={off} autoComplete="off" spellCheck={false} />
        <p className="text-muted-foreground text-xs">{provider === "resend" ? t("channelsUi.email.senderHintResend") : t("channelsUi.email.senderHint")}</p>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="em-token">{provider === "resend" ? t("channelsUi.email.tokenResend") : t("channelsUi.email.token")}</Label>
        <Input id="em-token" ref={token} type="password" dir="ltr" disabled={off} autoComplete="new-password" spellCheck={false} />
      </div>
      {provider === "resend" ? (
        <>
          <div className="grid gap-1">
            <Label htmlFor="em-hook">{t("channelsUi.email.webhookSecret")}</Label>
            <Input id="em-hook" ref={hookSecret} type="password" dir="ltr" disabled={off} autoComplete="new-password" spellCheck={false} />
            <p className="text-muted-foreground text-xs">{t("channelsUi.email.webhookSecretHint")}</p>
          </div>
          <p className="text-sm">
            <span className="font-semibold">{t("channelsUi.email.webhookUrl")}</span>
            <bdi dir="ltr" className="text-muted-foreground block break-all font-mono text-xs">
              {resendWebhookUrl}
            </bdi>
          </p>
        </>
      ) : null}
      <Button type="submit" className="justify-self-start" disabled={off}>
        {t("channelsUi.email.submit")}
      </Button>
      <p role="status" aria-live="polite" className={notice?.error ? "text-destructive-text text-sm" : "text-muted-foreground text-sm"}>
        {notice?.text ?? ""}
      </p>
    </form>
  );
}

/** Pause / reprise d'envoi d'un canal. Une reprise ne rend jamais un canal « actif » : seul le fournisseur le valide. */
export function ChannelPause({ channelId, paused }: { channelId: string; paused: boolean }) {
  const t = useTranslations("Integrations");
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function toggle(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const response = await post("/api/channels/update", { channel_id: channelId, send_paused: !paused });
      if (response.ok) router.refresh();
      else toast.error(t("channelsUi.failed"));
    } catch {
      toast.error(t("channelsUi.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void toggle()}>
      {paused ? t("channelsUi.resume") : t("channelsUi.pause")}
    </Button>
  );
}

/** Ajouter un canal (autre adresse ou numéro) à une intégration existante. */
export function AddChannel({ integrationId, type }: { integrationId: string; type: "email" | "whatsapp" }) {
  const t = useTranslations("Integrations");
  const router = useRouter();
  const sender = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  async function add(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const field = sender.current;
    if (busy || !field || !field.value) return;
    setBusy(true);
    try {
      const response = await post("/api/channels", { integration_id: integrationId, type, sender_identity: field.value.trim(), project_scope: [] });
      if (response.ok) {
        field.value = "";
        setNotice({ text: t("channelsUi.added"), error: false });
        router.refresh();
      } else {
        setNotice({ text: response.status === 409 ? t("channelsUi.email.duplicate") : response.status === 400 ? t("channelsUi.email.invalid") : t("channelsUi.failed"), error: true });
      }
    } catch {
      setNotice({ text: t("channelsUi.failed"), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={add} className="grid gap-2" autoComplete="off">
      <Label htmlFor={`add-${integrationId}`}>{t(type === "email" ? "channelsUi.addEmail" : "channelsUi.addPhone")}</Label>
      <div className="flex flex-wrap gap-2">
        <Input id={`add-${integrationId}`} ref={sender} dir="ltr" className="max-w-xs" disabled={busy} autoComplete="off" spellCheck={false} />
        <Button type="submit" variant="outline" disabled={busy}>
          {t("channelsUi.add")}
        </Button>
      </div>
      <p role="status" aria-live="polite" className={notice?.error ? "text-destructive-text text-sm" : "text-muted-foreground text-sm"}>
        {notice?.text ?? ""}
      </p>
    </form>
  );
}
