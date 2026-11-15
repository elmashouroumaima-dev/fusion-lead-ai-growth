"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** Marque UNE notification du membre connecté comme lue (J39b). Le serveur ne laisse marquer que les siennes. */
export function MarkReadButton({ notificationId }: { notificationId: string }) {
  const t = useTranslations("Notifications");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function mark(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/notifications/read", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ notification_id: notificationId }),
      });
      if (response.ok) router.refresh();
      else {
        setError(t("failed"));
        toast.error(t("failed"));
      }
    } catch {
      setError(t("failed"));
      toast.error(t("failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-1">
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void mark()}>
        {t("markRead")}
      </Button>
      {error ? (
        <p role="alert" className="text-destructive-text text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
