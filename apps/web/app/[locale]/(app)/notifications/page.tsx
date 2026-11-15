import { localeSchema } from "@fusion-leap/domain";
import { can } from "@fusion-leap/permissions";
import { getFormatter, getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { MarkReadButton } from "../../../../components/notifications/mark-read-button";
import { Link } from "../../../../i18n/navigation";
import { requireLocale } from "../../../../i18n/require-locale";
import { listNotifications } from "../../../../lib/assignment/service";
import { requireClaims } from "../../../../lib/auth/require-claims";
import { createClient } from "../../../../lib/supabase/server";
import { requireTenantContext } from "../../../../lib/tenant/context";

export const dynamic = "force-dynamic";

/**
 * Notifications du membre connecté (J39b) : « lead non assigné » (J22) et « envoi en échec » (J39). Owner et admin, qui sont les
 * destinataires ; chacun ne voit que SES notifications (RLS). La charge utile ne contient que des identifiants et un motif.
 */
export default async function NotificationsPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = localeSchema.parse(await requireLocale(params));
  const t = await getTranslations({ locale, namespace: "Notifications" });
  await requireClaims(locale);
  const ctx = await requireTenantContext(locale);
  if (!can(ctx.role, "manage", "assignment_rules")) redirect(`/${locale}/dashboard`);

  const format = await getFormatter({ locale });
  let items: Awaited<ReturnType<typeof listNotifications>> | null = null;
  try {
    items = await listNotifications(await createClient(), ctx.organizationId, { limit: 100 });
  } catch {
    items = null;
  }

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-3xl gap-6">
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground max-w-prose text-sm">{t("description")}</p>
      </header>
      {items === null ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t("loadFailed")}</AlertDescription>
        </Alert>
      ) : items.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("empty")}</p>
      ) : (
        <ul className="grid gap-3">
          {items.map((item) => (
            <li key={item.id}>
              <Card>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="grid gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{t(`kind.${item.kind}`)}</span>
                      {item.read_at === null ? <Badge>{t("unread")}</Badge> : null}
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {item.kind === "lead.unassigned" ? t(`reason.${item.payload.reason}`) : `${t("job")} : ${item.payload.job_kind}`}
                      {" · "}
                      {format.dateTime(new Date(item.created_at), { dateStyle: "medium", timeStyle: "short" })}
                    </p>
                    {item.kind === "lead.unassigned" ? (
                      <Link href={`/leads/${item.payload.lead_id}`} className="text-primary-text w-fit text-sm underline underline-offset-2">
                        {t("openLead")}
                      </Link>
                    ) : (
                      <Link href="/operations" className="text-primary-text w-fit text-sm underline underline-offset-2">
                        {t("openOperations")}
                      </Link>
                    )}
                  </div>
                  {item.read_at === null ? <MarkReadButton notificationId={item.id} /> : null}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
