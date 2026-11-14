"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { acquireLockAction, releaseLockAction, takeOverAction } from "../../lib/inbox/lock-actions";
import type { LockActionState } from "../../lib/inbox/types";

/**
 * Composeur de réponse (J38). Le fil est tenu par UN seul rédacteur : un bail de 5 minutes est pris au focus puis renouvelé toutes les
 * 2 minutes tant qu'un texte est en cours, et libéré quand on vide ou quitte le champ. Si un autre membre rédige ou si l'IA tient la
 * conversation, le champ est désactivé (jamais l'identité de l'autre) ; « Reprendre la main » est proposé quand c'est l'IA. L'envoi
 * (`POST /api/conversations/:id/replies`, `Idempotency-Key`, la même clé tant que la réponse n'a pas abouti) met la réponse en
 * file : c'est le WORKER qui envoie, après le contrôle final. Le serveur revérifie tout (rôle, attribution, verrou, canal, consentement).
 */
const HEARTBEAT_MS = 2 * 60 * 1000;
export const REPLY_MAX = 10_000;

type Lock = "none" | "mine" | "other" | "ai";

const lockFormData = (conversationId: string, uiLocale: string): FormData => {
  const fd = new FormData();
  fd.set("uiLocale", uiLocale);
  fd.set("conversation_id", conversationId);
  return fd;
};
const IDLE: LockActionState = { status: "idle" };

export function ReplyComposer({ conversationId, initialLock }: { conversationId: string; initialLock: Lock }) {
  const t = useTranslations("Inbox.reply");
  const uiLocale = useLocale();
  const router = useRouter();
  const uid = useId();
  const [body, setBody] = useState("");
  const [lock, setLock] = useState<Lock>(initialLock);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef<string | null>(null);
  const bodyRef = useRef("");
  const lockRef = useRef<Lock>(initialLock);
  useEffect(() => {
    bodyRef.current = body;
    lockRef.current = lock;
  }, [body, lock]);

  // Le serveur redessine la page toutes les 15 s : on suit l'état réel tant qu'on ne tient pas soi-même le bail.
  useEffect(() => {
    if (lockRef.current !== "mine") setLock(initialLock);
  }, [initialLock]);

  const acquire = useCallback(async (): Promise<Lock> => {
    const result = await acquireLockAction(IDLE, lockFormData(conversationId, uiLocale));
    const next: Lock = result.status === "success" && result.lock ? (result.lock === "mine" ? "mine" : result.lock === "ai" ? "ai" : "other") : lockRef.current;
    setLock(next);
    return next;
  }, [conversationId, uiLocale]);

  // Battement de cœur : renouvelle le bail tant qu'un texte est en cours.
  useEffect(() => {
    if (lock !== "mine") return;
    const timer = window.setInterval(() => {
      if (bodyRef.current.length > 0 && document.visibilityState !== "hidden") void acquire();
    }, HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [lock, acquire]);

  // Libère le bail en quittant la page (le bail expire de toute façon au bout de 5 minutes).
  useEffect(() => {
    return () => {
      if (lockRef.current === "mine") void releaseLockAction(IDLE, lockFormData(conversationId, uiLocale));
    };
  }, [conversationId, uiLocale]);

  async function onFocus() {
    if (lockRef.current === "none" || lockRef.current === "mine") await acquire();
  }

  async function onBlur() {
    if (bodyRef.current.trim().length === 0 && lockRef.current === "mine") {
      setLock("none");
      await releaseLockAction(IDLE, lockFormData(conversationId, uiLocale));
    }
  }

  async function takeOver() {
    setError(null);
    const result = await takeOverAction(IDLE, lockFormData(conversationId, uiLocale));
    if (result.status === "success") {
      await acquire();
      router.refresh();
    } else setError(t(result.code === "forbidden" ? "errors.forbidden" : "errors.generic"));
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const text = body.trim();
    if (text.length === 0 || pending) return;
    setPending(true);
    setError(null);
    // Même clé tant que la réponse n'a pas abouti : un double clic ou un rejeu réseau ne crée qu'UN message.
    keyRef.current ??= crypto.randomUUID();
    try {
      const response = await fetch(`/api/conversations/${conversationId}/replies`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": keyRef.current },
        body: JSON.stringify({ body: text }),
      });
      if (response.status === 202) {
        keyRef.current = null;
        setBody("");
        setLock("none");
        toast.success(t("success.queued"));
        router.refresh();
      } else if (response.status === 409) {
        setError(t("errors.conflict"));
        keyRef.current = null;
        await acquire();
      } else if (response.status === 403) {
        setError(t("errors.forbidden"));
      } else if (response.status === 404) {
        setError(t("errors.not_found"));
      } else if (response.status === 429) {
        setError(t("errors.rate_limited"));
      } else if (response.status === 400) {
        keyRef.current = null;
        setError(t("errors.invalid_input"));
      } else {
        setError(t("errors.generic"));
      }
    } catch {
      setError(t("errors.generic"));
    } finally {
      setPending(false);
    }
  }

  const blocked = lock === "other" || lock === "ai";
  return (
    <form onSubmit={send} className="grid gap-3" aria-labelledby={`${uid}-label`}>
      {lock === "other" ? (
        <Alert role="status">
          <AlertDescription>{t("lock.other")}</AlertDescription>
        </Alert>
      ) : null}
      {lock === "ai" ? (
        <Alert role="status">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{t("lock.ai")}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void takeOver()}>
              {t("lock.takeOver")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <Label id={`${uid}-label`} htmlFor={`${uid}-body`}>
        {t("label")}
      </Label>
      <Textarea
        id={`${uid}-body`}
        name="body"
        value={body}
        maxLength={REPLY_MAX}
        rows={5}
        disabled={blocked || pending}
        placeholder={t("placeholder")}
        onChange={(event) => setBody(event.target.value)}
        onFocus={() => void onFocus()}
        onBlur={() => void onBlur()}
        error={error !== null}
        aria-describedby={`${uid}-hint`}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p id={`${uid}-hint`} className="text-muted-foreground text-xs">
          {t("hint", { count: body.length, max: REPLY_MAX })}
        </p>
        <Button type="submit" disabled={blocked || pending || body.trim().length === 0}>
          {pending ? t("sending") : t("send")}
        </Button>
      </div>
      <div role="status" aria-live="polite" className="empty:hidden">
        {error ? <p className="text-destructive-text text-sm">{error}</p> : null}
      </div>
    </form>
  );
}
