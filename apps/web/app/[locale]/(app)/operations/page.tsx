import { localeSchema } from "@fusion-leap/domain";
import { can } from "@fusion-leap/permissions";
import { getFormatter, getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmergencyStop } from "../../../../components/operations/emergency-stop";
import { ReplayButton } from "../../../../components/operations/replay-button";
import { requireLocale } from "../../../../i18n/require-locale";
import { requireClaims } from "../../../../lib/auth/require-claims";
import { isEmergencyStopActive, listDeadLetters } from "../../../../lib/operations/service";
import { createClient } from "../../../../lib/supabase/server";
import { requireTenantContext } from "../../../../lib/tenant/context";

export const dynamic = "force-dynamic";

/**
 * Exploitation des envois (J39) : arrêt d'urgence (owner, admin, marketing) et dead letters avec rejeu (owner et admin). Les autres rôles
 * sont renvoyés au tableau de bord. La page ne lit que des identifiants, la nature du job, le nombre de tentatives et une erreur courte
 * déjà nettoyée : jamais de charge utile ni de corps de message. La RLS et les fonctions SQL revérifient chaque droit.
 */
export default async function OperationsPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = localeSchema.parse(await requireLocale(params));
  const t = await getTranslations({ locale, namespace: "Operations" });
  await requireClaims(locale);
  const ctx = await requireTenantContext(locale);
  const canStop = can(ctx.role, "emergency_stop", "sending");
  const canSeeDead = can(ctx.role, "view", "dead_letter");
  if (!canStop && !canSeeDead) redirect(`/${locale}/dashboard`);

  const format = await getFormatter({ locale });
  const supabase = await createClient();
  let paused: boolean | null = null;
  try {
    paused = await isEmergencyStopActive(supabase, ctx.organizationId);
  } catch {
    paused = null;
  }
  let dead: Awaited<ReturnType<typeof listDeadLetters>> | null = null;
  if (canSeeDead) {
    try {
      dead = await listDeadLetters(supabase, ctx.organizationId);
    } catch {
      dead = null;
    }
  }
  const canReplay = can(ctx.role, "replay", "dead_letter");

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-5xl gap-6">
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground max-w-prose text-sm">{t("description")}</p>
      </header>

      {canStop ? (
        <Card>
          <CardHeader>
            <h2 className="text-lg font-medium">{t("stop.title")}</h2>
          </CardHeader>
          <CardContent>
            {paused === null ? (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{t("stop.failed")}</AlertDescription>
              </Alert>
            ) : (
              <EmergencyStop paused={paused} canResume={ctx.role === "company_owner" || ctx.role === "company_admin"} />
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <h2 className="text-lg font-medium">{t("dead.title")}</h2>
        </CardHeader>
        <CardContent>
          {!canSeeDead ? (
            <p className="text-muted-foreground text-sm">{t("dead.readOnly")}</p>
          ) : dead === null ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{t("dead.loadFailed")}</AlertDescription>
            </Alert>
          ) : dead.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("dead.empty")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr className="text-muted-foreground border-b text-start">
                    <th className="py-2 pe-3 text-start font-medium">{t("dead.kind")}</th>
                    <th className="py-2 pe-3 text-start font-medium">{t("dead.attempts")}</th>
                    <th className="py-2 pe-3 text-start font-medium">{t("dead.error")}</th>
                    <th className="py-2 pe-3 text-start font-medium">{t("dead.when")}</th>
                    {canReplay ? <th className="py-2 text-start font-medium">{t("dead.action")}</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {dead.map((job) => (
                    <tr key={job.id} className="border-b last:border-0">
                      <td className="py-2 pe-3 font-mono text-xs">{job.kind}</td>
                      <td className="py-2 pe-3">{job.attempts}</td>
                      <td className="py-2 pe-3 font-mono text-xs">{job.last_error ?? "-"}</td>
                      <td className="py-2 pe-3">{job.finished_at ? format.dateTime(new Date(job.finished_at), { dateStyle: "medium", timeStyle: "short" }) : "-"}</td>
                      {canReplay ? (
                        <td className="py-2">
                          <ReplayButton jobId={job.id} />
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
