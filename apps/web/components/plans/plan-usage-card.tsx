import { AlertTriangleIcon, GaugeIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Alert } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { AuthLocale, UsageRow } from "@fusion-leap/domain";

/** Couleur de la barre : vert sous 70 %, ambre jusqu'à 90 %, rouge au-delà (le texte et `near_limit` portent aussi l'information). */
function toneClass(percent: number): string {
  if (percent >= 90) return "bg-destructive";
  if (percent >= 70) return "bg-amber-500";
  return "bg-brand";
}

/**
 * Utilisation du plan (owner / admin) : une barre par métrique limitée, avertissement dès 80 % (`near_limit`),
 * blocage signalé à 100 %. Les métriques sans limite ne sont pas affichées.
 */
export async function PlanUsageCard({ rows, locale }: { rows: UsageRow[]; locale: AuthLocale }) {
  const t = await getTranslations({ locale, namespace: "Dashboard" });
  const limited = rows.filter((r) => r.limit !== null);
  if (limited.length === 0) return null;
  const warnings = limited.filter((r) => r.near_limit);

  return (
    <Card role="region" aria-labelledby="dash-usage-title" className="md:col-span-2">
      <CardHeader>
        <CardTitle id="dash-usage-title" className="flex items-center gap-2">
          <GaugeIcon className="text-primary-text size-4" aria-hidden="true" />
          <h2>{t("usage.title")}</h2>
        </CardTitle>
        <CardDescription>{t("usage.description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {warnings.length > 0 ? (
          <Alert role="status">
            <AlertTriangleIcon className="size-4" aria-hidden="true" />
            <p className="text-sm">
              {warnings.some((w) => w.limit !== null && w.used >= w.limit) ? t("usage.blocked") : t("usage.nearLimit")}
            </p>
          </Alert>
        ) : null}
        <ul className="grid gap-3">
          {limited.map((row) => {
            const limit = row.limit ?? 0;
            const percent = limit === 0 ? 100 : Math.min(100, Math.round((row.used * 100) / limit));
            return (
              <li key={row.metric} className="grid gap-1">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span>{t(`usage.metrics.${row.metric}`)}</span>
                  <span className="text-muted-foreground tabular-nums" dir="ltr">
                    {row.used} / {limit}
                  </span>
                </div>
                <div
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={limit}
                  aria-valuenow={Math.min(row.used, limit)}
                  aria-label={t(`usage.metrics.${row.metric}`)}
                  className="bg-muted h-2.5 overflow-hidden rounded-full"
                >
                  <div className={`h-full rounded-full transition-all ${toneClass(percent)}`} style={{ width: `${percent}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
