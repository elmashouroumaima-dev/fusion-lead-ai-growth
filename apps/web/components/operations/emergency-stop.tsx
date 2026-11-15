"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

type Props = { paused: boolean };

/**
 * Arrêt d'urgence d'envoi (J39). Arrêter demande une confirmation en deux temps ; reprendre est immédiat. Chaque envoi porte une clé
 * d'idempotence neuve. L'état affiché vient du serveur (rechargé après l'action) : le navigateur ne décide de rien.
 */
export function EmergencyStop({ paused }: Props) {
  const t = useTranslations("Operations.stop");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply(next: boolean): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/send/emergency-stop", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ paused: next }),
      });
      if (response.ok) {
        toast.success(next ? t("stopped") : t("resumed"));
        setConfirming(false);
        router.refresh();
      } else {
        const text = response.status === 403 ? t("forbidden") : t("failed");
        setError(text);
        toast.error(text);
      }
    } catch {
      setError(t("failed"));
      toast.error(t("failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3">
      <Alert variant={paused ? "destructive" : "default"} role={paused ? "alert" : "status"}>
        <AlertDescription>{paused ? t("active") : t("inactive")}</AlertDescription>
      </Alert>
      <div className="flex flex-wrap items-center gap-2">
        {paused ? (
          <Button type="button" disabled={busy} onClick={() => void apply(false)}>
            {t("resumeButton")}
          </Button>
        ) : confirming ? (
          <>
            <Button type="button" variant="destructive" disabled={busy} onClick={() => void apply(true)}>
              {t("confirm")}
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
              {t("cancel")}
            </Button>
          </>
        ) : (
          <Button type="button" variant="destructive" onClick={() => setConfirming(true)}>
            {t("stopButton")}
          </Button>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-destructive-text text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
