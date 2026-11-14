import { CALL_OUTCOMES, type ActivityRow, type AuthLocale } from "@fusion-leap/domain";
import { ArrowRightLeftIcon, CalendarIcon, ListChecksIcon, MailIcon, PhoneIcon, StickyNoteIcon, UserRoundCheckIcon, type LucideIcon } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import { TaskToggleForm } from "./lead-activity-form";

type Props = {
  locale: AuthLocale;
  activities: readonly ActivityRow[];
  /** Nom des étapes du pipeline (identifiant -> nom). */
  stageNames: ReadonlyMap<string, string>;
  /** Identifiant de l'utilisateur connecté (« Moi »). */
  userId: string;
  organizationId: string;
  /** Peut marquer une tâche faite ou à refaire (owner, admin, commercial sur son lead). */
  canWrite: boolean;
};

const ICONS: Record<ActivityRow["type"], LucideIcon> = {
  note: StickyNoteIcon,
  call: PhoneIcon,
  email: MailIcon,
  meeting: CalendarIcon,
  task: ListChecksIcon,
  stage_change: ArrowRightLeftIcon,
  assignment: UserRoundCheckIcon,
};

const shortIdOf = (id: string): string => id.replace(/-/g, "").slice(-6).toUpperCase();
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const isOutcome = (value: unknown): value is (typeof CALL_OUTCOMES)[number] => typeof value === "string" && (CALL_OUTCOMES as readonly string[]).includes(value);

/**
 * Chronologie d'un lead, la plus récente d'abord. Les entrées AUTOMATIQUES (changement d'étape, assignation : écrites par la base)
 * sont distinguées des entrées saisies. Le contenu saisi (notes, comptes rendus) n'est jamais écrit dans les journaux ni l'audit :
 * il n'est affiché qu'ici, aux rôles qui peuvent lire le lead.
 */
export async function LeadTimeline({ locale, activities, stageNames, userId, organizationId, canWrite }: Props) {
  const t = await getTranslations({ locale, namespace: "Lead" });
  const tc = await getTranslations({ locale, namespace: "Crm" });
  const format = await getFormatter({ locale });

  if (activities.length === 0) return <p className="text-muted-foreground text-sm">{t("timeline.empty")}</p>;

  const stage = (id: unknown): string => (typeof id === "string" ? (stageNames.get(id) ?? t("timeline.unknownStage")) : t("timeline.unknownStage"));
  const member = (id: unknown): string =>
    typeof id !== "string" ? tc("assignee.none") : id === userId ? tc("assignee.me") : tc("assignee.member", { id: shortIdOf(id) });
  const author = (ownerId: string | null): string => (ownerId === null ? t("timeline.system") : member(ownerId));
  const date = (value: string, withTime = false) =>
    format.dateTime(new Date(value), withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" });

  return (
    <ol className="grid gap-3">
      {activities.map((activity) => {
        const Icon = ICONS[activity.type];
        const automatic = activity.type === "stage_change" || activity.type === "assignment";
        const m = activity.metadata;
        const isTask = activity.type === "task";
        return (
          <li key={activity.id} className="grid grid-cols-[auto_1fr] gap-3 rounded-xl border p-4 text-sm">
            <span className="bg-brand/15 text-primary-text grid size-9 place-items-center rounded-lg">
              <Icon className="size-4" aria-hidden="true" />
            </span>
            <div className="grid min-w-0 gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{t(`entry.${activity.type}`)}</span>
                {automatic ? <Badge variant="outline">{t("timeline.automatic")}</Badge> : null}
                {isTask ? (
                  activity.completed_at ? (
                    <Badge variant="success">{t("task.doneOn", { date: date(activity.completed_at) })}</Badge>
                  ) : (
                    <Badge variant="secondary">{t("task.open")}</Badge>
                  )
                ) : null}
              </div>

              {activity.type === "note" ? <p className="whitespace-pre-wrap">{text(m.text)}</p> : null}

              {activity.type === "call" ? (
                <div className="grid gap-1">
                  <div className="text-muted-foreground flex flex-wrap gap-x-3 text-xs">
                    {isOutcome(m.outcome) ? <span>{t(`outcomes.${m.outcome}`)}</span> : null}
                    {typeof m.duration_minutes === "number" ? <span>{t("timeline.minutes", { minutes: format.number(m.duration_minutes) })}</span> : null}
                  </div>
                  {text(m.text) ? <p className="whitespace-pre-wrap">{text(m.text)}</p> : null}
                </div>
              ) : null}

              {activity.type === "email" ? (
                <div className="grid gap-1">
                  <p className="font-medium">{text(m.subject)}</p>
                  {text(m.text) ? <p className="whitespace-pre-wrap">{text(m.text)}</p> : null}
                </div>
              ) : null}

              {activity.type === "meeting" || isTask ? (
                <div className="grid gap-1">
                  <p className="font-medium">{text(m.title)}</p>
                  {text(m.text) ? <p className="whitespace-pre-wrap">{text(m.text)}</p> : null}
                  {activity.due_at ? <p className="text-muted-foreground text-xs">{t("timeline.due", { date: date(activity.due_at) })}</p> : null}
                </div>
              ) : null}

              {activity.type === "stage_change" ? (
                <p>
                  {m.deal_id ? <span className="text-muted-foreground">{t("timeline.dealPrefix")} </span> : null}
                  <bdi>{stage(m.from_stage_id)}</bdi>
                  <span aria-hidden="true" className="mx-1.5 inline-block rtl:rotate-180">
                    →
                  </span>
                  <span className="sr-only"> {t("timeline.to")} </span>
                  <bdi>{stage(m.to_stage_id)}</bdi>
                </p>
              ) : null}

              {activity.type === "assignment" ? (
                <p>
                  <bdi>{member(m.from_assignee_id)}</bdi>
                  <span aria-hidden="true" className="mx-1.5 inline-block rtl:rotate-180">
                    →
                  </span>
                  <span className="sr-only"> {t("timeline.to")} </span>
                  <bdi>{member(m.to_assignee_id)}</bdi>
                </p>
              ) : null}

              <p className="text-muted-foreground text-xs">
                {date(activity.created_at, true)} · {t("timeline.by", { who: author(activity.owner_id) })}
              </p>

              {isTask && canWrite ? (
                <TaskToggleForm
                  activityId={activity.id}
                  organizationId={organizationId}
                  idempotencyKey={crypto.randomUUID()}
                  done={activity.completed_at !== null}
                />
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
