"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export type BatchView = {
  id: string;
  status: "uploaded" | "queued" | "running" | "done" | "failed" | "cancelled";
  projectName: string | null;
  rowCount: number | null;
  created: number;
  matched: number;
  skipped: number;
  errors: number;
  errorCode: string | null;
  dateLabel: string;
};

const VARIANT = { uploaded: "outline", queued: "secondary", running: "secondary", done: "success", failed: "destructive", cancelled: "outline" } as const;

/**
 * Suivi des imports (J39c) : état et compteurs de chaque lot, rapport CSV téléchargeable (numéro de ligne, résultat, motif : AUCUNE donnée de
 * contact) et annulation d'un lot « envoyé » ou « en file ». L'état ne se met pas à jour tout seul : « Actualiser » relit le serveur.
 */
export function ImportBatches({ batches }: { batches: BatchView[] }) {
  const t = useTranslations("Imports");
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function cancel(id: string): Promise<void> {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      const response = await fetch("/api/imports/cancel", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ batch_id: id }) });
      if (response.ok) {
        toast.success(t("confirm.cancelled"));
        router.refresh();
      } else {
        const text = response.status === 409 ? t("batches.cannotCancel") : t("errors.generic");
        setError(text);
        toast.error(text);
      }
    } catch {
      setError(t("errors.generic"));
      toast.error(t("errors.generic"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-3">
      <div>
        <Button type="button" size="sm" variant="outline" onClick={() => router.refresh()}>
          {t("batches.refresh")}
        </Button>
      </div>
      {batches.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("batches.empty")}</p>
      ) : (
        <ul className="grid gap-3">
          {batches.map((batch) => (
            <li key={batch.id} className="grid gap-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={VARIANT[batch.status]}>{t(`batches.status.${batch.status}`)}</Badge>
                <span className="font-medium">{batch.projectName === null ? t("batches.projectUnknown") : <bdi>{batch.projectName}</bdi>}</span>
                <span className="text-muted-foreground text-xs">{batch.dateLabel}</span>
              </div>
              <p className="text-muted-foreground text-xs">
                {t("batches.counts", { rows: batch.rowCount ?? 0, created: batch.created, matched: batch.matched, skipped: batch.skipped, errors: batch.errors })}
              </p>
              {batch.errorCode ? <p className="text-destructive-text text-xs">{t("batches.errorCode", { code: batch.errorCode })}</p> : null}
              <div className="flex flex-wrap gap-2">
                {batch.status === "done" || batch.status === "failed" ? (
                  <Button asChild size="sm" variant="outline">
                    <a href={`/api/imports/report?batch_id=${batch.id}`} download>
                      {t("batches.report")}
                    </a>
                  </Button>
                ) : null}
                {batch.status === "uploaded" || batch.status === "queued" ? (
                  <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void cancel(batch.id)}>
                    {t("batches.cancel")}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <p role="alert" className="text-destructive-text text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
