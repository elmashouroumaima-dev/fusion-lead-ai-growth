"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export type FormKeyView = { id: string; keyPrefix: string; origins: string[]; active: boolean; createdLabel: string };

type Props = { projectId: string; keys: FormKeyView[]; disabled: boolean };

const parseOrigins = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

async function post(path: string, payload: Record<string, unknown>): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(payload),
  });
}

/**
 * Clés de formulaire d'un projet (J39b, ADR 007). La clé EN CLAIR n'existe que dans la réponse de la création : elle est affichée une seule
 * fois, dans un état local de ce composant, puis disparaît (« Masquer » ou rechargement) ; elle n'est ni écrite dans l'URL, ni dans le
 * stockage du navigateur, ni relue du serveur. La liste ne montre que le préfixe non secret. Le serveur revérifie owner / admin.
 */
export function FormKeysCard({ projectId, keys, disabled }: Props) {
  const t = useTranslations("FormKeys");
  const router = useRouter();
  const origins = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<{ key: string } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  function fail(status: number): void {
    const text = status === 403 ? t("forbidden") : status === 400 ? t("invalid") : status === 409 ? t("limit") : t("failed");
    setError(text);
    toast.error(text);
  }

  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const field = origins.current;
    if (busy || !field) return;
    setBusy(true);
    setError(null);
    try {
      const response = await post("/api/forms/keys", { project_id: projectId, allowed_origins: parseOrigins(field.value) });
      if (response.ok) {
        const body = (await response.json()) as { key?: unknown };
        if (typeof body.key === "string") setShown({ key: body.key });
        field.value = "";
        toast.success(t("created"));
        router.refresh();
      } else {
        fail(response.status);
      }
    } catch {
      setError(t("failed"));
      toast.error(t("failed"));
    } finally {
      setBusy(false);
    }
  }

  async function setActive(id: string, active: boolean): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await post("/api/forms/keys/active", { key_id: id, active });
      if (response.ok) {
        toast.success(active ? t("reactivated") : t("revoked"));
        setRevoking(null);
        router.refresh();
      } else {
        fail(response.status);
      }
    } catch {
      setError(t("failed"));
      toast.error(t("failed"));
    } finally {
      setBusy(false);
    }
  }

  async function copy(): Promise<void> {
    if (!shown) return;
    try {
      await navigator.clipboard.writeText(shown.key);
      toast.success(t("copied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  }

  return (
    <div className="grid gap-4">
      {shown ? (
        <Alert role="status">
          <AlertDescription className="grid gap-2">
            <p className="text-sm font-medium">{t("showOnce")}</p>
            <code dir="ltr" className="bg-muted block rounded-md p-2 text-xs break-all select-all">
              {shown.key}
            </code>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={() => void copy()}>
                {t("copy")}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setShown(null)}>
                {t("hide")}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {keys.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("empty")}</p>
      ) : (
        <ul className="grid gap-3">
          {keys.map((key) => (
            <li key={key.id} className="grid gap-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <code dir="ltr" className="text-sm">
                  {key.keyPrefix}
                </code>
                <Badge variant={key.active ? "success" : "outline"}>{key.active ? t("active") : t("revokedBadge")}</Badge>
                <span className="text-muted-foreground text-xs">{key.createdLabel}</span>
              </div>
              <ul dir="ltr" className="text-muted-foreground grid gap-0.5 text-xs">
                {key.origins.map((origin) => (
                  <li key={origin}>{origin}</li>
                ))}
              </ul>
              {disabled ? null : key.active ? (
                revoking === key.id ? (
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void setActive(key.id, false)}>
                      {t("confirmRevoke")}
                    </Button>
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setRevoking(null)}>
                      {t("cancel")}
                    </Button>
                  </div>
                ) : (
                  <div>
                    <Button type="button" size="sm" variant="outline" onClick={() => setRevoking(key.id)}>
                      {t("revoke")}
                    </Button>
                  </div>
                )
              ) : (
                <div>
                  <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void setActive(key.id, true)}>
                    {t("reactivate")}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {disabled ? null : (
        <form onSubmit={(event) => void create(event)} className="grid gap-2">
          <Label htmlFor="form-key-origins">{t("originsLabel")}</Label>
          <Textarea id="form-key-origins" ref={origins} dir="ltr" rows={3} required />
          <p className="text-muted-foreground text-xs">{t("originsHelp")}</p>
          <div>
            <Button type="submit" disabled={busy}>
              {t("create")}
            </Button>
          </div>
        </form>
      )}
      {error ? (
        <p role="alert" className="text-destructive-text text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
