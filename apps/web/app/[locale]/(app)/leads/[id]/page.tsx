import { localeSchema, uuidSchema, type DealRow } from "@fusion-leap/domain";
import { can } from "@fusion-leap/permissions";
import { ArrowLeftIcon } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LeadActivityForm } from "../../../../../components/crm/lead-activity-form";
import { LeadTimeline } from "../../../../../components/crm/lead-timeline";
import { Link } from "../../../../../i18n/navigation";
import { requireLocale } from "../../../../../i18n/require-locale";
import { listTimeline, nextActionsFor, TIMELINE_PAGE_SIZE } from "../../../../../lib/activities/queries";
import { requireClaims } from "../../../../../lib/auth/require-claims";
import { getContact } from "../../../../../lib/contacts/queries";
import { getLead, listDeals, listPipelines, listStages } from "../../../../../lib/leads/queries";
import { listProjects } from "../../../../../lib/projects/queries";
import { createClient } from "../../../../../lib/supabase/server";
import { requireTenantContext } from "../../../../../lib/tenant/context";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string; id: string }> };

const KNOWN_SOURCES = ["web_form", "csv_import", "manual"] as const;
const isKnownSource = (value: string): value is (typeof KNOWN_SOURCES)[number] => (KNOWN_SOURCES as readonly string[]).includes(value);
const shortIdOf = (userId: string): string => userId.replace(/-/g, "").slice(-6).toUpperCase();
const BADGE_VARIANT = { open: "secondary", won: "success", lost: "destructive", unassigned: "outline" } as const;

/**
 * Fiche d'un lead (J30c) : résumé (étape, responsable, source, projet), contact, prochaine action, deals, chronologie des activités
 * (notes, appels, tâches et entrées automatiques d'étape et d'assignation) et formulaire d'ajout. Rôles : owner, admin et marketing
 * lisent tous les leads, le commercial les siens (un autre lead est introuvable : RLS), l'analyste est renvoyé au tableau de bord.
 * Ajouter une note, un appel ou une tâche : owner, admin et commercial sur son lead ; la base revérifie.
 */
export default async function LeadPage({ params }: Props) {
  const { id: rawId } = await params;
  const locale = localeSchema.parse(await requireLocale(params));
  const t = await getTranslations({ locale, namespace: "Lead" });
  const tc = await getTranslations({ locale, namespace: "Crm" });
  await requireClaims(locale);
  const ctx = await requireTenantContext(locale);
  if (!can(ctx.role, "read", "leads", { isOwnRecord: true })) redirect(`/${locale}/dashboard`);
  const id = uuidSchema.safeParse(rawId);
  if (!id.success) notFound();

  const supabase = await createClient();
  let loaded: Awaited<ReturnType<typeof loadLead>> | null = null;
  let failed = false;
  try {
    loaded = await loadLead(supabase, ctx.organizationId, id.data);
  } catch {
    failed = true;
  }
  if (!failed && !loaded) notFound();

  const format = await getFormatter({ locale });
  const lead = loaded?.lead ?? null;
  const canWrite = lead !== null && can(ctx.role, "manage_tasks", "leads", { isOwnRecord: lead.assignee_id === ctx.userId });
  const canOpenContact = can(ctx.role, "read", "contacts");
  const stage = lead ? loaded?.stages.find((item) => item.id === lead.stage_id) : undefined;
  const project = lead ? loaded?.projects.find((item) => item.id === lead.project_id) : undefined;
  const contactName = loaded?.contact?.name ?? t("contact.unnamed");
  const sourceLabel = (source: string) => (isKnownSource(source) ? tc(`sources.${source}`) : source);
  const money = (deal: DealRow) => {
    try {
      return format.number(deal.value, { style: "currency", currency: deal.currency });
    } catch {
      return `${format.number(deal.value)} ${deal.currency}`;
    }
  };

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-4xl gap-6">
      <header className="grid gap-1">
        <Link href="/leads" className="text-primary-text hover:bg-accent -ms-2 flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium">
          <ArrowLeftIcon className="size-4 rtl:-scale-x-100" aria-hidden="true" />
          {t("back")}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          <bdi>{contactName}</bdi>
        </h1>
      </header>

      {failed || !loaded || !lead ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t("errors.load")}</AlertDescription>
        </Alert>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <Card role="region" aria-labelledby="lead-summary-title">
              <CardHeader>
                <CardTitle id="lead-summary-title">
                  <h2>{t("summary.title")}</h2>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">{t("summary.stage")}</dt>
                  <dd>
                    {stage ? (
                      <Badge variant={BADGE_VARIANT[stage.kind]}>
                        <bdi>{stage.name}</bdi>
                      </Badge>
                    ) : (
                      "—"
                    )}
                  </dd>
                  <dt className="text-muted-foreground">{t("summary.assignee")}</dt>
                  <dd>
                    {lead.assignee_id === null
                      ? tc("assignee.none")
                      : lead.assignee_id === ctx.userId
                        ? tc("assignee.me")
                        : tc("assignee.member", { id: shortIdOf(lead.assignee_id) })}
                  </dd>
                  <dt className="text-muted-foreground">{t("summary.source")}</dt>
                  <dd>{sourceLabel(lead.source)}</dd>
                  <dt className="text-muted-foreground">{t("summary.project")}</dt>
                  <dd>
                    <bdi>{project?.name ?? "—"}</bdi>
                  </dd>
                  <dt className="text-muted-foreground">{t("summary.created")}</dt>
                  <dd>{format.dateTime(new Date(lead.created_at), { dateStyle: "medium" })}</dd>
                </dl>
              </CardContent>
            </Card>

            <Card role="region" aria-labelledby="lead-contact-title">
              <CardHeader>
                <CardTitle id="lead-contact-title">
                  <h2>{t("contact.title")}</h2>
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3">
                {loaded.contact ? (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                    <dt className="text-muted-foreground">{t("contact.email")}</dt>
                    <dd>
                      <bdi dir="ltr">{loaded.contact.email_raw ?? "—"}</bdi>
                    </dd>
                    <dt className="text-muted-foreground">{t("contact.phone")}</dt>
                    <dd>
                      <bdi dir="ltr">{loaded.contact.phone_e164 ?? "—"}</bdi>
                    </dd>
                  </dl>
                ) : (
                  <p className="text-muted-foreground text-sm">{t("contact.unavailable")}</p>
                )}
                {canOpenContact && loaded.contact ? (
                  <Link href={`/contacts/${loaded.contact.id}`} className="text-primary-text w-fit text-sm font-medium underline underline-offset-2">
                    {t("contact.open")}
                  </Link>
                ) : null}
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Card role="region" aria-labelledby="lead-next-title">
              <CardHeader>
                <CardTitle id="lead-next-title">
                  <h2>{t("next.title")}</h2>
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-1 text-sm">
                {loaded.next ? (
                  <>
                    <p className="font-medium">
                      <bdi>{typeof loaded.next.metadata.title === "string" ? loaded.next.metadata.title : t("next.untitled")}</bdi>
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {loaded.next.due_at ? t("timeline.due", { date: format.dateTime(new Date(loaded.next.due_at), { dateStyle: "medium" }) }) : t("next.noDue")}
                    </p>
                  </>
                ) : (
                  <p className="text-muted-foreground">{t("next.none")}</p>
                )}
              </CardContent>
            </Card>

            <Card role="region" aria-labelledby="lead-deals-title">
              <CardHeader>
                <CardTitle id="lead-deals-title">
                  <h2>{t("deals.title")}</h2>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {loaded.deals.length === 0 ? (
                  <p className="text-muted-foreground text-sm">{t("deals.none")}</p>
                ) : (
                  <ul className="grid gap-2 text-sm">
                    {loaded.deals.map((deal) => (
                      <li key={deal.id} className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium tabular-nums">
                          <bdi dir="ltr">{money(deal)}</bdi>
                        </span>
                        <Badge variant={deal.won_at ? "success" : deal.lost_at ? "destructive" : "secondary"}>
                          <bdi>{loaded.stages.find((item) => item.id === deal.stage_id)?.name ?? "—"}</bdi>
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          {canWrite ? (
            <Card role="region" aria-labelledby="lead-form-title">
              <CardHeader>
                <CardTitle id="lead-form-title">
                  <h2>{t("form.title")}</h2>
                </CardTitle>
                <CardDescription>{t("form.description")}</CardDescription>
              </CardHeader>
              <CardContent>
                <LeadActivityForm leadId={lead.id} organizationId={ctx.organizationId} idempotencyKey={crypto.randomUUID()} />
              </CardContent>
            </Card>
          ) : (
            <p className="text-muted-foreground text-sm">{t("readOnly")}</p>
          )}

          <Card role="region" aria-labelledby="lead-timeline-title">
            <CardHeader>
              <CardTitle id="lead-timeline-title">
                <h2>{t("timeline.title")}</h2>
              </CardTitle>
              <CardDescription>{t("timeline.description")}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <LeadTimeline
                locale={locale}
                activities={loaded.timeline}
                stageNames={new Map(loaded.stages.map((item) => [item.id, item.name]))}
                userId={ctx.userId}
                organizationId={ctx.organizationId}
                canWrite={canWrite}
              />
              {loaded.timeline.length >= TIMELINE_PAGE_SIZE ? (
                <p className="text-muted-foreground text-xs">{t("timeline.latest", { count: format.number(TIMELINE_PAGE_SIZE) })}</p>
              ) : null}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

/** Lectures de la fiche, avec les droits de l'utilisateur (RLS) : `null` si le lead n'est pas visible (autre entreprise, lead d'un autre commercial). */
async function loadLead(supabase: Awaited<ReturnType<typeof createClient>>, organizationId: string, leadId: string) {
  const lead = await getLead(supabase, organizationId, leadId);
  if (!lead) return null;
  const [stages, projects, timeline, next, deals, contact] = await Promise.all([
    listPipelines(supabase, organizationId).then(async (pipelines) => {
      const pipeline = pipelines.find((item) => item.is_default) ?? pipelines[0];
      return pipeline ? listStages(supabase, organizationId, pipeline.id) : [];
    }),
    listProjects(supabase, organizationId),
    listTimeline(supabase, organizationId, leadId),
    nextActionsFor(supabase, organizationId, [leadId]),
    listDeals(supabase, organizationId, { leadId }),
    getContact(supabase, organizationId, lead.contact_id).catch(() => null),
  ]);
  return { lead, stages, projects, timeline, next: next.get(leadId) ?? null, deals, contact };
}
