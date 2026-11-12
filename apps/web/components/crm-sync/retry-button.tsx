"use client";

import { RefreshCwIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

type Props = { integrationId: string; name: string };

/**
 * « Réessayer » : rejoue la dernière synchro en échec (`POST /api/crm/sync/retry`, clé d'idempotence par clic). Le résultat est annoncé
 * (notification + message écrit dans la page, car la notification disparaît seule), puis la page est rafraîchie.
 */
export function RetrySyncButton({ integrationId, name }: Props) {
  const t = useTranslations("CrmSync");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const key = useRef(crypto.randomUUID());

  async function retry(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/crm/sync/retry", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key.current },
        body: JSON.stringify({ integration_id: integrationId }),
      });
      const body = (await response.json().catch(() => null)) as { retried?: boolean } | null;
      if (response.ok && body?.retried) {
        setMessage({ text: t("retried"), error: false });
        toast.success(t("retried"));
        key.current = crypto.randomUUID();
        router.refresh();
      } else if (response.ok) {
        setMessage({ text: t("retryNothing"), error: false });
      } else {
        setMessage({ text: t("retryFailed"), error: true });
        toast.error(t("retryFailed"));
        key.current = crypto.randomUUID();
      }
    } catch {
      setMessage({ text: t("retryFailed"), error: true });
      toast.error(t("retryFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid justify-items-start gap-1">
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void retry()} aria-label={t("retryNamed", { name })}>
        <RefreshCwIcon aria-hidden="true" className={busy ? "animate-spin" : undefined} />
        {t("retry")}
      </Button>
      {message ? (
        <p role={message.error ? "alert" : "status"} className={message.error ? "text-destructive-text text-xs" : "text-muted-foreground text-xs"}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
