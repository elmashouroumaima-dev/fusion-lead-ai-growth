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

/** Message pour un code de validation du serveur (codes courts : jamais un texte du fournisseur). */
function verifyText(t: ReturnType<typeof useTranslations>, body: { status?: string; code?: string } | null): string {
  if (body?.status === "active") return t("whatsapp.verify.ok");
  if (body?.code === "provider_auth") return t("whatsapp.verify.auth");
  if (body?.code === "provider_account") return t("whatsapp.verify.account");
  return t("whatsapp.verify.unreadable");
}

/**
 * « Vérifier la connexion » (J34) : le serveur essaie le jeton auprès de Meta et enregistre le résultat. Le navigateur ne voit jamais le jeton.
 */
export function VerifyConnection({ integrationId }: { integrationId: string }) {
  const t = useTranslations("Integrations");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  async function verify(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const response = await post("/api/integrations/validate", { integration_id: integrationId });
      if (response.ok) {
        const body = (await response.json()) as { status?: string; code?: string };
        setNotice({ text: verifyText(t, body), error: body.status !== "active" });
        router.refresh();
      } else if (response.status === 503) {
        setNotice({ text: t("whatsapp.verify.unavailable"), error: true });
      } else {
        setNotice({ text: t("whatsapp.verify.failed"), error: true });
      }
    } catch {
      setNotice({ text: t("whatsapp.verify.failed"), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2">
      <Button type="button" variant="outline" className="justify-self-start" disabled={busy} onClick={() => void verify()}>
        {t("whatsapp.verify.button")}
      </Button>
      <p role="status" aria-live="polite" className={notice?.error ? "text-destructive-text text-sm" : "text-muted-foreground text-sm"}>
        {notice?.text ?? ""}
      </p>
    </div>
  );
}

/**
 * Connexion d'un numéro WhatsApp (J34) : identifiant du numéro, jeton d'accès et secret de l'app (champs en ÉCRITURE SEULE, vidés dès l'envoi, jamais
 * conservés dans un état ni une adresse). Trois appels dans l'ordre : création de l'intégration (jeton chiffré côté serveur), enregistrement du
 * secret de webhook, vérification auprès de Meta. Chaque envoi porte sa clé d'idempotence.
 */
export function ConnectWhatsApp({ encryptionConfigured }: { encryptionConfigured: boolean }) {
  const t = useTranslations("Integrations");
  const router = useRouter();
  const phone = useRef<HTMLInputElement>(null);
  const token = useRef<HTMLInputElement>(null);
  const appSecret = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  async function connect(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const phoneField = phone.current;
    const tokenField = token.current;
    const secretField = appSecret.current;
    if (busy || !phoneField || !tokenField || !secretField || !phoneField.value || !tokenField.value || !secretField.value) return;
    const values = { phone: phoneField.value.trim(), token: tokenField.value, secret: secretField.value };
    tokenField.value = "";
    secretField.value = "";
    setBusy(true);
    try {
      const created = await post("/api/integrations", { provider: "whatsapp", external_account_id: values.phone, scopes: [], secret: values.token });
      if (created.status === 409) {
        setNotice({ text: t("whatsapp.connect.duplicate"), error: true });
        return;
      }
      if (!created.ok) {
        setNotice({ text: created.status === 400 ? t("whatsapp.connect.invalid") : t("whatsapp.connect.failed"), error: true });
        return;
      }
      const { integration } = (await created.json()) as { integration: { id: string } };
      const id = integration.id;
      const hook = await post("/api/integrations/webhook-secret", { integration_id: id, secret: values.secret });
      if (!hook.ok) {
        setNotice({ text: hook.status === 400 ? t("whatsapp.connect.secretInvalid") : t("whatsapp.connect.failed"), error: true });
        router.refresh();
        return;
      }
      const verified = await post("/api/integrations/validate", { integration_id: id });
      const body = verified.ok ? ((await verified.json()) as { status?: string; code?: string }) : null;
      setNotice({ text: verified.ok ? verifyText(t, body) : t("whatsapp.verify.unavailable"), error: body?.status !== "active" });
      if (body?.status === "active") {
        phoneField.value = "";
        toast.success(t("whatsapp.verify.ok"));
      }
      router.refresh();
    } catch {
      setNotice({ text: t("whatsapp.connect.failed"), error: true });
    } finally {
      setBusy(false);
    }
  }

  const off = !encryptionConfigured || busy;
  return (
    <form onSubmit={connect} className="grid gap-3 rounded-lg border p-4" autoComplete="off">
      <h2 className="text-lg leading-none font-semibold">{t("whatsapp.connect.title")}</h2>
      <p className="text-muted-foreground text-sm">{t("whatsapp.connect.description")}</p>
      <div className="grid gap-1">
        <Label htmlFor="wa-phone">{t("whatsapp.connect.phoneId")}</Label>
        <Input id="wa-phone" ref={phone} inputMode="numeric" pattern="[0-9]{5,30}" dir="ltr" disabled={off} autoComplete="off" spellCheck={false} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="wa-token">{t("whatsapp.connect.token")}</Label>
        <Input id="wa-token" ref={token} type="password" dir="ltr" disabled={off} autoComplete="new-password" spellCheck={false} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="wa-secret">{t("whatsapp.connect.appSecret")}</Label>
        <Input id="wa-secret" ref={appSecret} type="password" dir="ltr" disabled={off} autoComplete="new-password" spellCheck={false} />
        <p className="text-muted-foreground text-xs">{t("whatsapp.connect.appSecretHint")}</p>
      </div>
      <Button type="submit" className="justify-self-start" disabled={off}>
        {t("whatsapp.connect.submit")}
      </Button>
      <p role="status" aria-live="polite" className={notice?.error ? "text-destructive-text text-sm" : "text-muted-foreground text-sm"}>
        {notice?.text ?? ""}
      </p>
    </form>
  );
}
