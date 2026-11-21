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
type Gateway = "meta" | "kapso";
type VerifyName = "ok" | "auth" | "account" | "unreadable" | "unavailable" | "failed" | "button";
const verifyMsg = (t: ReturnType<typeof useTranslations>, gateway: Gateway, name: VerifyName): string => (gateway === "kapso" ? t(`kapso.verify.${name}`) : t(`whatsapp.verify.${name}`));

function verifyText(t: ReturnType<typeof useTranslations>, body: { status?: string; code?: string } | null, gateway: Gateway = "meta"): string {
  if (body?.status === "active") return verifyMsg(t, gateway, "ok");
  if (body?.code === "provider_auth") return verifyMsg(t, gateway, "auth");
  if (body?.code === "provider_account") return verifyMsg(t, gateway, "account");
  return verifyMsg(t, gateway, "unreadable");
}

/**
 * « Vérifier la connexion » (J34) : le serveur essaie le jeton auprès de Meta et enregistre le résultat. Le navigateur ne voit jamais le jeton.
 */
export function VerifyConnection({ integrationId, gateway = "meta" }: { integrationId: string; gateway?: Gateway }) {
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
        setNotice({ text: verifyText(t, body, gateway), error: body.status !== "active" });
        router.refresh();
      } else if (response.status === 503) {
        setNotice({ text: verifyMsg(t, gateway, "unavailable"), error: true });
      } else {
        setNotice({ text: verifyMsg(t, gateway, "failed"), error: true });
      }
    } catch {
      setNotice({ text: verifyMsg(t, gateway, "failed"), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2">
      <Button type="button" variant="outline" className="justify-self-start" disabled={busy} onClick={() => void verify()}>
        {verifyMsg(t, gateway, "button")}
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

/** Secret de webhook aléatoire (64 caractères hexadécimaux), généré dans le navigateur : il n'est envoyé qu'à l'enregistrement et n'est pas conservé. */
const randomSecret = (): string => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Connexion d'un numéro WhatsApp par Kapso (ADR 017) : identifiant du numéro, clé d'API de Kapso et secret de webhook (champs en ÉCRITURE SEULE, vidés dès
 * l'envoi). Le secret de webhook est CELUI QUE VOUS CHOISISSEZ (bouton « Générer ») : il se recopie chez Kapso, dans le webhook du numéro, avec l'adresse
 * affichée. Trois appels dans l'ordre : création (clé chiffrée côté serveur, passerelle `kapso`), secret de webhook, vérification auprès de Kapso.
 */
export function ConnectKapso({ encryptionConfigured, webhookUrl }: { encryptionConfigured: boolean; webhookUrl: string }) {
  const t = useTranslations("Integrations");
  const router = useRouter();
  const phone = useRef<HTMLInputElement>(null);
  const apiKey = useRef<HTMLInputElement>(null);
  const hookSecret = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  async function connect(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const phoneField = phone.current;
    const keyField = apiKey.current;
    const secretField = hookSecret.current;
    if (busy || !phoneField || !keyField || !secretField || !phoneField.value || !keyField.value || !secretField.value) return;
    const values = { phone: phoneField.value.trim(), key: keyField.value, secret: secretField.value };
    keyField.value = "";
    secretField.value = "";
    setBusy(true);
    try {
      const created = await post("/api/integrations", { provider: "whatsapp", gateway: "kapso", external_account_id: values.phone, scopes: [], secret: values.key });
      if (created.status === 409) {
        setNotice({ text: t("kapso.connect.duplicate"), error: true });
        return;
      }
      if (!created.ok) {
        setNotice({ text: created.status === 400 ? t("kapso.connect.invalid") : t("kapso.connect.failed"), error: true });
        return;
      }
      const { integration } = (await created.json()) as { integration: { id: string } };
      const hook = await post("/api/integrations/webhook-secret", { integration_id: integration.id, secret: values.secret });
      if (!hook.ok) {
        setNotice({ text: hook.status === 400 ? t("kapso.connect.secretInvalid") : t("kapso.connect.failed"), error: true });
        router.refresh();
        return;
      }
      const verified = await post("/api/integrations/validate", { integration_id: integration.id });
      const body = verified.ok ? ((await verified.json()) as { status?: string; code?: string }) : null;
      setNotice({ text: verified.ok ? verifyText(t, body, "kapso") : t("kapso.verify.unavailable"), error: body?.status !== "active" });
      if (body?.status === "active") {
        phoneField.value = "";
        toast.success(t("kapso.verify.ok"));
      }
      router.refresh();
    } catch {
      setNotice({ text: t("kapso.connect.failed"), error: true });
    } finally {
      setBusy(false);
    }
  }

  const off = !encryptionConfigured || busy;
  return (
    <form onSubmit={connect} className="grid gap-3 rounded-lg border p-4" autoComplete="off">
      <h2 className="text-lg leading-none font-semibold">{t("kapso.connect.title")}</h2>
      <p className="text-muted-foreground text-sm">{t("kapso.connect.description")}</p>
      <div className="grid gap-1">
        <Label htmlFor="kp-phone">{t("kapso.connect.phoneId")}</Label>
        <Input id="kp-phone" ref={phone} inputMode="numeric" pattern="[0-9]{5,30}" dir="ltr" disabled={off} autoComplete="off" spellCheck={false} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="kp-key">{t("kapso.connect.apiKey")}</Label>
        <Input id="kp-key" ref={apiKey} type="password" dir="ltr" disabled={off} autoComplete="new-password" spellCheck={false} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="kp-secret">{t("kapso.connect.webhookSecret")}</Label>
        <div className="flex flex-wrap gap-2">
          <Input id="kp-secret" ref={hookSecret} type="text" dir="ltr" className="max-w-md font-mono" disabled={off} autoComplete="off" spellCheck={false} />
          <Button
            type="button"
            variant="outline"
            disabled={off}
            onClick={() => {
              if (hookSecret.current) hookSecret.current.value = randomSecret();
            }}
          >
            {t("kapso.connect.generate")}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">{t("kapso.connect.webhookSecretHint")}</p>
      </div>
      <div className="grid gap-1 text-sm">
        <span className="font-semibold">{t("kapso.connect.webhookUrl")}</span>
        <bdi dir="ltr" className="font-mono text-xs break-all">
          {webhookUrl}
        </bdi>
        <p className="text-muted-foreground text-xs">{t("kapso.connect.webhookUrlHint")}</p>
      </div>
      <Button type="submit" className="justify-self-start" disabled={off}>
        {t("kapso.connect.submit")}
      </Button>
      <p role="status" aria-live="polite" className={notice?.error ? "text-destructive-text text-sm" : "text-muted-foreground text-sm"}>
        {notice?.text ?? ""}
      </p>
    </form>
  );
}
