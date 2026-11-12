"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";

type Stage = { id: string; name: string; kind: "open" | "won" | "lost" | "unassigned" };
type Deal = { id: string; stageId: string; value: number | null; currency: string; contactName: string | null };

type Props = { stages: readonly Stage[]; deals: readonly Deal[]; canMove: boolean };

const ERROR_KEYS = { forbidden: "forbidden", not_found: "notFound", conflict: "conflict", rate_limited: "rateLimited" } as const;

/**
 * Tableau des deals par étape. Déplacer un deal : glisser-déposer (souris, tactile selon le navigateur) OU le menu « Déplacer vers »
 * de la carte (clavier et lecteurs d'écran : l'alternative n'est jamais optionnelle). Dans les deux cas : `POST /api/deals/move`
 * (couche service -> fonction SQL `move_deal_stage`, qui valide rôle, propriété et étape), mise à jour optimiste annulée si le serveur
 * refuse. Une zone `aria-live` annonce le résultat. Les colonnes suivent la direction du document (RTL en arabe).
 */
export function DealBoard({ stages, deals: initial, canMove }: Props) {
  const t = useTranslations("Crm");
  const format = useFormatter();
  const [deals, setDeals] = useState<readonly Deal[]>(initial);
  const [announcement, setAnnouncement] = useState("");
  // dernier échec de déplacement : écrit dans la page (la notification rouge disparaît seule)
  const [error, setError] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);
  const pending = useRef(new Set<string>());

  const money = (value: number, currency: string): string => {
    try {
      return format.number(value, { style: "currency", currency });
    } catch {
      return `${format.number(value)} ${currency}`;
    }
  };

  async function move(dealId: string, stageId: string): Promise<void> {
    const deal = deals.find((item) => item.id === dealId);
    const stage = stages.find((item) => item.id === stageId);
    if (!canMove || !deal || !stage || deal.stageId === stageId || pending.current.has(dealId)) return;
    pending.current.add(dealId);
    const previous = deal.stageId;
    setDeals((all) => all.map((item) => (item.id === dealId ? { ...item, stageId } : item)));
    let message = t("errors.moveFailed");
    let ok = false;
    try {
      const response = await fetch("/api/deals/move", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ deal_id: dealId, stage_id: stageId }),
      });
      ok = response.ok;
      if (!ok) {
        const body = (await response.json().catch(() => null)) as { code?: string } | null;
        const key = ERROR_KEYS[body?.code as keyof typeof ERROR_KEYS];
        message = key ? t(`errors.${key}`) : t("errors.generic");
      }
    } catch {
      message = t("errors.generic");
    } finally {
      pending.current.delete(dealId);
    }
    if (ok) {
      message = t("deals.moved", { stage: stage.name });
      toast.success(message);
      setError(null);
    } else {
      // le serveur a refusé : la carte revient dans sa colonne d'origine
      setDeals((all) => all.map((item) => (item.id === dealId ? { ...item, stageId: previous } : item)));
      toast.error(message);
      setError(message);
    }
    setAnnouncement(message);
  }

  return (
    <div>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {error ? (
        <p role="alert" className="text-destructive-text mb-3 text-sm">
          {error}
        </p>
      ) : null}
      <div role="group" aria-label={t("deals.boardLabel")} className="flex gap-4 overflow-x-auto pb-2">
        {stages.map((stage) => {
          const inStage = deals.filter((deal) => deal.stageId === stage.id);
          const totals = new Map<string, number>();
          for (const deal of inStage) if (deal.value !== null) totals.set(deal.currency, (totals.get(deal.currency) ?? 0) + deal.value);
          return (
            <section
              key={stage.id}
              aria-label={t("deals.columnLabel", { name: stage.name })}
              onDragOver={canMove ? (event) => { event.preventDefault(); setOverStage(stage.id); } : undefined}
              onDragLeave={canMove ? () => setOverStage((current) => (current === stage.id ? null : current)) : undefined}
              onDrop={
                canMove
                  ? (event) => {
                      event.preventDefault();
                      setOverStage(null);
                      const dealId = event.dataTransfer.getData("text/plain");
                      if (dealId) void move(dealId, stage.id);
                    }
                  : undefined
              }
              className={`bg-muted/40 flex w-72 shrink-0 flex-col gap-3 rounded-lg border p-3 ${overStage === stage.id ? "ring-primary ring-2" : ""}`}
            >
              <header className="grid gap-1">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold">
                    <bdi>{stage.name}</bdi>
                  </h2>
                  <Badge variant={stage.kind === "won" ? "success" : stage.kind === "lost" ? "destructive" : "secondary"}>{inStage.length}</Badge>
                </div>
                {totals.size > 0 ? (
                  <p className="text-muted-foreground text-xs">{[...totals].map(([currency, sum]) => money(sum, currency)).join(" · ")}</p>
                ) : null}
              </header>
              {inStage.length === 0 ? (
                <p className="text-muted-foreground rounded-md border border-dashed p-3 text-center text-xs">{t("deals.columnEmpty")}</p>
              ) : (
                <ul className="grid gap-2">
                  {inStage.map((deal) => (
                    <li
                      key={deal.id}
                      draggable={canMove}
                      onDragStart={(event) => {
                        event.dataTransfer.setData("text/plain", deal.id);
                        event.dataTransfer.effectAllowed = "move";
                      }}
                      className={`bg-card grid gap-2 rounded-md border p-3 shadow-xs ${canMove ? "cursor-grab active:cursor-grabbing" : ""}`}
                    >
                      <p className="text-sm font-medium">
                        <bdi>{deal.contactName ?? t("table.noName")}</bdi>
                      </p>
                      {deal.value !== null ? <p className="text-muted-foreground text-xs">{money(deal.value, deal.currency)}</p> : null}
                      {canMove ? (
                        <select
                          aria-label={t("deals.moveLabel", { name: deal.contactName ?? t("table.noName") })}
                          value=""
                          onChange={(event) => void move(deal.id, event.target.value)}
                          className="border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:ring-[3px]"
                        >
                          <option value="">{t("deals.moveChoose")}</option>
                          {stages
                            .filter((target) => target.id !== deal.stageId)
                            .map((target) => (
                              <option key={target.id} value={target.id}>
                                {target.name}
                              </option>
                            ))}
                        </select>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
