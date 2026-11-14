import { CONVERSATION_STATES, INBOX_CHANNELS, localeSchema } from "@fusion-leap/domain";
import { can } from "@fusion-leap/permissions";
import { ChevronLeftIcon, ChevronRightIcon, InboxIcon, MailIcon, MessageCircleIcon, SearchIcon } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AutoRefresh } from "../../../../components/inbox/auto-refresh";
import { Link } from "../../../../i18n/navigation";
import { requireLocale } from "../../../../i18n/require-locale";
import { requireClaims } from "../../../../lib/auth/require-claims";
import { inboxHref, parseInboxParams, searchInbox, type InboxPage } from "../../../../lib/inbox/queries";
import { createClient } from "../../../../lib/supabase/server";
import { requireTenantContext } from "../../../../lib/tenant/context";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const shortIdOf = (userId: string): string => userId.replace(/-/g, "").slice(-6).toUpperCase();
const selectClass =
  "border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs outline-none focus-visible:ring-[3px] md:text-sm";
const STATE_VARIANT = { open: "secondary", pending: "warning", closed: "outline", to_triage: "destructive" } as const;

/**
 * Boîte de réception unifiée (J37) : e-mail et WhatsApp dans une même liste, la plus récemment active d'abord, avec le nom du contact,
 * le canal, l'état, le responsable et un APERÇU du dernier message (jamais le corps entier). Filtres (état, canal, responsable) et
 * recherche en GET (URL partageable). Rôles : owner et admin voient toutes les conversations, le commercial SES conversations ;
 * marketing et analyste sont renvoyés au tableau de bord. Actualisation par polling toutes les 15 s (ADR 013).
 */
export default async function InboxPage({ params, searchParams }: Props) {
  const locale = localeSchema.parse(await requireLocale(params));
  const t = await getTranslations({ locale, namespace: "Inbox" });
  const tc = await getTranslations({ locale, namespace: "Crm" });
  await requireClaims(locale);
  const ctx = await requireTenantContext(locale);
  if (!can(ctx.role, "read", "conversations", { isOwnRecord: true })) redirect(`/${locale}/dashboard`);

  const { filters, page } = parseInboxParams(await searchParams);
  let loaded: InboxPage | null = null;
  try {
    loaded = await searchInbox(await createClient(), ctx.organizationId, ctx.userId, filters, page);
  } catch {
    loaded = null;
  }
  const format = await getFormatter({ locale });
  const ownOnly = !can(ctx.role, "read", "conversations");
  const filtered = filters.state !== null || filters.channel !== null || filters.assignee !== "all" || filters.query !== null;

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-6xl gap-6">
      <AutoRefresh />
      <header className="grid gap-1">
        <h1 id="inbox-title" className="text-2xl font-semibold tracking-tight md:text-3xl">
          {t("title")}
        </h1>
        <p className="text-muted-foreground max-w-prose text-sm">{t("description")}</p>
        {ownOnly ? <p className="text-muted-foreground text-xs">{t("ownOnlyHint")}</p> : null}
      </header>

      <Card>
        <CardContent>
          <form method="get" role="search" aria-label={t("filters.label")} className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="inbox-q">{t("filters.search")}</Label>
              <div className="relative">
                <SearchIcon aria-hidden="true" className="text-muted-foreground pointer-events-none absolute inset-y-0 start-3 my-auto size-4" />
                <Input id="inbox-q" name="q" type="search" defaultValue={filters.query ?? ""} placeholder={t("filters.searchPlaceholder")} maxLength={100} autoComplete="off" className="ps-9" />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="grid gap-1.5">
                <Label htmlFor="inbox-state">{t("filters.state")}</Label>
                <select id="inbox-state" name="state" defaultValue={filters.state ?? ""} className={selectClass}>
                  <option value="">{t("filters.all")}</option>
                  {CONVERSATION_STATES.map((value) => (
                    <option key={value} value={value}>
                      {t(`states.${value}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="inbox-channel">{t("filters.channel")}</Label>
                <select id="inbox-channel" name="channel" defaultValue={filters.channel ?? ""} className={selectClass}>
                  <option value="">{t("filters.all")}</option>
                  {INBOX_CHANNELS.map((value) => (
                    <option key={value} value={value}>
                      {t(`channels.${value}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="inbox-assignee">{t("filters.assignee")}</Label>
                <select id="inbox-assignee" name="assignee" defaultValue={filters.assignee} className={selectClass}>
                  <option value="all">{t("filters.all")}</option>
                  <option value="me">{t("filters.mine")}</option>
                  {!ownOnly ? <option value="none">{t("filters.unassigned")}</option> : null}
                </select>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit">
                <SearchIcon aria-hidden="true" />
                {t("filters.apply")}
              </Button>
              {filtered ? (
                <Button asChild variant="ghost">
                  <Link href="/inbox">{t("filters.reset")}</Link>
                </Button>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>

      {loaded === null ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t("errors.load")}</AlertDescription>
        </Alert>
      ) : (
        <Card className="min-w-0">
          <CardContent className="grid min-w-0 gap-4">
            <p className="text-muted-foreground text-sm" role="status">
              {t("count", { count: format.number(loaded.total) })}
            </p>
            {loaded.rows.length === 0 ? (
              <div className="text-muted-foreground flex flex-col items-center gap-3 rounded-2xl border border-dashed p-10 text-center text-sm">
                <span className="bg-brand/15 text-primary-text grid size-12 place-items-center rounded-full">
                  <InboxIcon className="size-6" aria-hidden="true" />
                </span>
                <p>{filtered ? t("emptyFiltered") : t("empty")}</p>
              </div>
            ) : (
              <ul aria-labelledby="inbox-title" className="grid gap-2">
                {loaded.rows.map((row) => {
                  const name = row.contact_name ?? row.contact_email ?? row.contact_phone ?? t("row.unnamed");
                  const ChannelIcon = row.channel_type === "email" ? MailIcon : MessageCircleIcon;
                  return (
                    <li key={row.id}>
                      <Link
                        href={`/inbox/${row.id}`}
                        aria-label={t("row.openNamed", { name })}
                        className="bg-card text-card-foreground hover:bg-accent focus-visible:ring-ring grid grid-cols-[auto_1fr_auto] items-start gap-3 rounded-xl border p-4 no-underline transition focus-visible:ring-2 focus-visible:outline-none"
                      >
                        <span className="bg-brand/15 text-primary-text grid size-9 place-items-center rounded-lg">
                          <ChannelIcon className="size-4" aria-hidden="true" />
                          <span className="sr-only">{t(`channels.${row.channel_type}`)}</span>
                        </span>
                        <div className="grid min-w-0 gap-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">
                              <bdi>{name}</bdi>
                            </span>
                            <Badge variant={STATE_VARIANT[row.state]}>{t(`states.${row.state}`)}</Badge>
                            {row.assignee_id === null ? <Badge variant="outline">{tc("assignee.none")}</Badge> : null}
                          </div>
                          {row.last_preview ? (
                            <p className="text-muted-foreground truncate text-sm">
                              {row.last_direction === "outbound" ? <span className="text-foreground">{t("row.you")} </span> : null}
                              <bdi>{row.last_preview}</bdi>
                              {row.last_truncated ? "…" : ""}
                            </p>
                          ) : (
                            <p className="text-muted-foreground text-sm">{t("row.noMessage")}</p>
                          )}
                          <p className="text-muted-foreground text-xs">
                            {row.assignee_id === null
                              ? null
                              : row.assignee_id === ctx.userId
                                ? tc("assignee.me")
                                : tc("assignee.member", { id: shortIdOf(row.assignee_id) })}
                          </p>
                        </div>
                        <time className="text-muted-foreground text-xs whitespace-nowrap" dateTime={row.last_message_at ?? undefined}>
                          {row.last_message_at ? format.dateTime(new Date(row.last_message_at), { dateStyle: "medium", timeStyle: "short" }) : ""}
                        </time>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
            {loaded.pageCount > 1 ? (
              <nav aria-label={t("pagination.label")} className="flex items-center justify-between gap-3">
                <Button asChild variant="outline" size="sm" className={loaded.page <= 1 ? "pointer-events-none opacity-50" : undefined}>
                  <Link href={inboxHref(filters, loaded.page - 1)} aria-disabled={loaded.page <= 1} tabIndex={loaded.page <= 1 ? -1 : undefined} rel="prev">
                    <ChevronLeftIcon aria-hidden="true" className="rtl:rotate-180" />
                    {t("pagination.previous")}
                  </Link>
                </Button>
                <span className="text-muted-foreground text-sm">
                  {t("pagination.status", { page: format.number(loaded.page), pageCount: format.number(loaded.pageCount) })}
                </span>
                <Button asChild variant="outline" size="sm" className={loaded.page >= loaded.pageCount ? "pointer-events-none opacity-50" : undefined}>
                  <Link href={inboxHref(filters, loaded.page + 1)} aria-disabled={loaded.page >= loaded.pageCount} tabIndex={loaded.page >= loaded.pageCount ? -1 : undefined} rel="next">
                    {t("pagination.next")}
                    <ChevronRightIcon aria-hidden="true" className="rtl:rotate-180" />
                  </Link>
                </Button>
              </nav>
            ) : null}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
