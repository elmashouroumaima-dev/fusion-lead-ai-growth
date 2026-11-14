import { CheckCircle2Icon, CircleIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { AuthLocale } from "@fusion-leap/domain";
import { Link } from "../../i18n/navigation";

export type ChecklistStep = { key: "project" | "lead" | "integration" | "member"; done: boolean; href: string };

/** Liste de démarrage : disparaît quand tout est fait. Seules les étapes dont l'état est connu et permis sont passées en entrée. */
export async function GettingStarted({ locale, steps }: { locale: AuthLocale; steps: ChecklistStep[] }) {
  const t = await getTranslations({ locale, namespace: "Dashboard" });
  if (steps.length === 0 || steps.every((s) => s.done)) return null;
  const done = steps.filter((s) => s.done).length;
  const percent = Math.round((done * 100) / steps.length);
  return (
    <Card role="region" aria-labelledby="dash-start-title">
      <CardHeader>
        <CardTitle id="dash-start-title">
          <h2>{t("start.title")}</h2>
        </CardTitle>
        <CardDescription>{t("start.progress", { done, total: steps.length })}</CardDescription>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-valuenow={done}
          aria-label={t("start.title")}
          className="bg-muted mt-1 h-1.5 overflow-hidden rounded-full"
        >
          <div className="bg-brand h-full rounded-full transition-all" style={{ width: `${percent}%` }} />
        </div>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2">
          {steps.map((step) => (
            <li key={step.key}>
              <Link
                href={step.href}
                className="text-foreground hover:bg-accent focus-visible:ring-ring flex items-start gap-3 rounded-lg p-2 text-sm transition focus-visible:ring-2 focus-visible:outline-none"
              >
                {step.done ? (
                  <CheckCircle2Icon className="text-success mt-0.5 size-4 shrink-0" aria-hidden="true" />
                ) : (
                  <CircleIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />
                )}
                <span className="grid gap-0.5">
                  <span className={step.done ? "text-muted-foreground font-medium" : "font-medium"}>
                    {t(`start.steps.${step.key}.title`)}
                  </span>
                  <span className="text-muted-foreground text-xs">{t(`start.steps.${step.key}.hint`)}</span>
                  <span className="sr-only">{step.done ? t("start.done") : t("start.todo")}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
