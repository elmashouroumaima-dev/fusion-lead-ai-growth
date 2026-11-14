import { localeSchema, uuidSchema } from "@fusion-leap/domain";
import { can } from "@fusion-leap/permissions";
import { ArrowLeftIcon, MailIcon, MessageCircleIcon } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AutoRefresh } from "../../../../../components/inbox/auto-refresh";
import { AssignConversationForm, ConversationStateForm } from "../../../../../components/inbox/conversation-controls";
import { ReplyComposer } from "../../../../../components/inbox/reply-composer";
import { Link } from "../../../../../i18n/navigation";
import { requireLocale } from "../../../../../i18n/require-locale";
import { requireClaims } from "../../../../../lib/auth/require-claims";
import { getConversationLock, listMessages, MESSAGES_PAGE_SIZE } from "../../../../../lib/conversations/service";
import { getInboxConversation } from "../../../../../lib/inbox/queries";
import { listOrganizationMembers } from "../../../../../lib/members/queries";
import { createClient } from "../../../../../lib/supabase/server";
import { requireTenantContext } from "../../../../../lib/tenant/context";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const shortIdOf = (userId: string): string => userId.replace(/-/g, "").slice(-6).toUpperCase();
const STATE_VARIANT = { open: "secondary", pending: "warning", closed: "outline", to_triage: "destructive" } as const;

/**
 * Fil d'une conversation (J37), en lecture : messages du plus ancien au plus récent (les plus anciens par pages de 50), état, responsable,
 * contact. Le CORPS d'un message n'est affiché qu'ici, aux rôles qui lisent la conversation (owner et admin toutes, le commercial les
 * siennes ; une conversation interdite ou d'une autre entreprise est introuvable). Assigner : owner et admin ; changer l'état : owner et
 * admin, le commercial sur les siennes. Répondre (J38) : owner et admin sur toute conversation, le commercial sur les siennes, par e-mail
 * seulement ; le composeur prend un bail de 5 minutes (verrou humain / IA) et le worker envoie après le contrôle final.
 */
export default async function ConversationPage({ params, searchParams }: Props) {
  const { id: rawId } = await params;
  const locale = localeSchema.parse(await requireLocale(params));
  const t = await getTranslations({ locale, namespace: "Inbox" });
  const tc = await getTranslations({ locale, namespace: "Crm" });
  const to = await getTranslations({ locale, namespace: "Org" });
  await requireClaims(locale);
  const ctx = await requireTenantContext(locale);
  if (!can(ctx.role, "read", "conversations", { isOwnRecord: true })) redirect(`/${locale}/dashboard`);
  const id = uuidSchema.safeParse(rawId);
  if (!id.success) notFound();

  const rawPage = (await searchParams).page;
  const pageNumber = Number.parseInt(Array.isArray(rawPage) ? (rawPage[0] ?? "1") : (rawPage ?? "1"), 10);
  const page = Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= 10_000 ? pageNumber : 1;

  const supabase = await createClient();
  let conversation: Awaited<ReturnType<typeof getInboxConversation>> = null;
  let messages: Awaited<ReturnType<typeof listMessages>> = [];
  let failed = false;
  try {
    conversation = await getInboxConversation(supabase, ctx.organizationId, id.data);
    if (conversation) messages = await listMessages(supabase, ctx.organizationId, conversation.id, page);
  } catch {
    failed = true;
  }
  if (!failed && !conversation) notFound();

  const format = await getFormatter({ locale });
  const canAssign = can(ctx.role, "assign", "unassigned_leads");
  const canSetState = conversation !== null && can(ctx.role, "reply", "conversations", { isOwnRecord: conversation.assignee_id === ctx.userId });
  const canOpenContact = can(ctx.role, "read", "contacts");
  const canReply = canSetState;
  // Verrou courant : l'état réel (jamais l'identité de l'autre rédacteur), relu à chaque rafraîchissement.
  let lock: "none" | "mine" | "other" | "ai" = "none";
  if (canReply && conversation) {
    const status = await getConversationLock(supabase, ctx.organizationId, conversation.id);
    if (status.ok) lock = status.value.handled_by === "ai_suggest" ? "ai" : status.value.lock;
  }
  let members: { value: string; label: string }[] = [];
  if (canAssign) {
    try {
      members = (await listOrganizationMembers(ctx))
        .filter((member) => member.status === "active" && (member.role === "company_owner" || member.role === "company_admin" || member.role === "sales_agent"))
        .map((member) => ({
          value: member.user_id,
          label: `${member.user_id === ctx.userId ? tc("assignee.me") : tc("assignee.member", { id: shortIdOf(member.user_id) })} · ${to(`roles.${member.role}`)}`,
        }));
    } catch {
      members = [];
    }
  }
  const name = conversation ? (conversation.contact_name ?? conversation.contact_email ?? conversation.contact_phone ?? t("row.unnamed")) : t("row.unnamed");
  const ChannelIcon = conversation?.channel_type === "email" ? MailIcon : MessageCircleIcon;
  // `listMessages` renvoie du plus récent au plus ancien : on lit de haut en bas du plus ancien au plus récent.
  const chronological = [...messages].reverse();

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-4xl gap-6">
      <AutoRefresh />
      <header className="grid gap-1">
        <Link href="/inbox" className="text-primary-text hover:bg-accent -ms-2 flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium">
          <ArrowLeftIcon className="size-4 rtl:-scale-x-100" aria-hidden="true" />
          {t("thread.back")}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          <bdi>{name}</bdi>
        </h1>
      </header>

      {failed || !conversation ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t("errors.load")}</AlertDescription>
        </Alert>
      ) : (
        <>
          <Card role="region" aria-labelledby="thread-summary-title">
            <CardHeader>
              <CardTitle id="thread-summary-title">
                <h2>{t("thread.summary")}</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">{t("thread.channel")}</dt>
                <dd className="flex items-center gap-2">
                  <ChannelIcon className="size-4" aria-hidden="true" />
                  {t(`channels.${conversation.channel_type}`)}
                </dd>
                <dt className="text-muted-foreground">{t("thread.stateLabel")}</dt>
                <dd>
                  <Badge variant={STATE_VARIANT[conversation.state]}>{t(`states.${conversation.state}`)}</Badge>
                </dd>
                <dt className="text-muted-foreground">{t("thread.assigneeLabel")}</dt>
                <dd>
                  {conversation.assignee_id === null
                    ? tc("assignee.none")
                    : conversation.assignee_id === ctx.userId
                      ? tc("assignee.me")
                      : tc("assignee.member", { id: shortIdOf(conversation.assignee_id) })}
                </dd>
                {conversation.contact_email ? (
                  <>
                    <dt className="text-muted-foreground">{t("thread.email")}</dt>
                    <dd>
                      <bdi dir="ltr">{conversation.contact_email}</bdi>
                    </dd>
                  </>
                ) : null}
                {conversation.contact_phone ? (
                  <>
                    <dt className="text-muted-foreground">{t("thread.phone")}</dt>
                    <dd>
                      <bdi dir="ltr">{conversation.contact_phone}</bdi>
                    </dd>
                  </>
                ) : null}
              </dl>
              {canOpenContact ? (
                <Link href={`/contacts/${conversation.contact_id}`} className="text-primary-text w-fit text-sm font-medium underline underline-offset-2">
                  {t("thread.openContact")}
                </Link>
              ) : null}
              {canAssign || canSetState ? (
                <div className="grid gap-6 border-t pt-4 md:grid-cols-2">
                  {canAssign ? (
                    <AssignConversationForm
                      conversationId={conversation.id}
                      idempotencyKey={crypto.randomUUID()}
                      currentAssigneeId={conversation.assignee_id}
                      members={members}
                    />
                  ) : null}
                  {canSetState ? (
                    <ConversationStateForm
                      conversationId={conversation.id}
                      idempotencyKey={crypto.randomUUID()}
                      currentState={conversation.state}
                      hasAssignee={conversation.assignee_id !== null}
                    />
                  ) : null}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card role="region" aria-labelledby="thread-messages-title">
            <CardHeader>
              <CardTitle id="thread-messages-title">
                <h2>{t("thread.messages")}</h2>
              </CardTitle>
              <CardDescription>{canReply ? t("reply.info") : t("reply.readOnly")}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              {messages.length >= MESSAGES_PAGE_SIZE ? (
                <Link href={`/inbox/${conversation.id}?page=${page + 1}`} className="text-primary-text w-fit text-sm font-medium underline underline-offset-2">
                  {t("thread.older")}
                </Link>
              ) : null}
              {chronological.length === 0 ? (
                <p className="text-muted-foreground text-sm">{t("thread.empty")}</p>
              ) : (
                <ol className="grid gap-3">
                  {chronological.map((message) => {
                    const outbound = message.direction === "outbound";
                    return (
                      <li key={message.id} className={outbound ? "ms-auto w-fit max-w-[85%]" : "me-auto w-fit max-w-[85%]"}>
                        <div className={outbound ? "bg-brand/15 grid gap-1 rounded-2xl rounded-ee-md p-3 text-sm" : "bg-muted grid gap-1 rounded-2xl rounded-es-md p-3 text-sm"}>
                          <p className="whitespace-pre-wrap break-words">
                            <bdi>{message.body}</bdi>
                          </p>
                          <p className="text-muted-foreground text-xs">
                            {format.dateTime(new Date(message.received_at ?? message.sent_at ?? message.created_at), { dateStyle: "medium", timeStyle: "short" })}
                            {" · "}
                            {outbound ? t("thread.sent") : t("thread.received")}
                            {outbound ? ` · ${t(`status.${message.status}`)}` : ""}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
              {page > 1 ? (
                <Link href={page - 1 > 1 ? `/inbox/${conversation.id}?page=${page - 1}` : `/inbox/${conversation.id}`} className="text-primary-text w-fit text-sm font-medium underline underline-offset-2">
                  {t("thread.newer")}
                </Link>
              ) : null}
            </CardContent>
          </Card>

          {canReply ? (
            <Card role="region" aria-labelledby="thread-reply-title">
              <CardHeader>
                <CardTitle id="thread-reply-title">
                  <h2>{t("reply.label")}</h2>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {conversation.channel_type === "email" ? (
                  <ReplyComposer conversationId={conversation.id} initialLock={lock} />
                ) : (
                  <p className="text-muted-foreground text-sm">{t("reply.unsupported")}</p>
                )}
              </CardContent>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
