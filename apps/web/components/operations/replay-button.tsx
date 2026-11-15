"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** Rejoue une dead letter (J39). Le serveur revérifie le rôle et l'entreprise ; une clé d'idempotence neuve par clic. */
export function ReplayButton({ jobId }: { jobId: string }) {
  const t = useTranslations("Operations.dead");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function replay(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/jobs/dead-letters/replay", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ job_id: jobId }),
      });
      if (response.ok) toast.success(t("replayed"));
      else {
        const text = response.status === 404 ? t("gone") : t("failed");
        setError(text);
        toast.error(text);
      }
      router.refresh();
    } catch {
      setError(t("failed"));
      toast.error(t("failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-1">
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void replay()}>
        {t("replay")}
      </Button>
      {error ? (
        <p role="alert" className="text-destructive-text text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
