import type { ActivityRow } from "./schemas";

/**
 * Règles pures de la chronologie et des tâches (J20, spec §3 : statut, responsable, prochaine action visibles). La base impose
 * l'essentiel (types, contenu, immutabilité) ; ces fonctions servent le service, l'interface et les tests.
 */

export function isTask(activity: Pick<ActivityRow, "type">): boolean {
  return activity.type === "task";
}

/** Tâche encore à faire (ni terminée) ? */
export function isOpenTask(activity: Pick<ActivityRow, "type" | "completed_at">): boolean {
  return activity.type === "task" && activity.completed_at === null;
}

/** Tâche ouverte dont l'échéance est atteinte (échue) à l'instant donné. Sans échéance : jamais « due ». */
export function isDue(activity: Pick<ActivityRow, "type" | "completed_at" | "due_at">, now: Date): boolean {
  return isOpenTask(activity) && activity.due_at !== null && new Date(activity.due_at).getTime() <= now.getTime();
}

const byDueThenCreated = (a: ActivityRow, b: ActivityRow): number => {
  const dueA = a.due_at === null ? Number.POSITIVE_INFINITY : new Date(a.due_at).getTime();
  const dueB = b.due_at === null ? Number.POSITIVE_INFINITY : new Date(b.due_at).getTime();
  return dueA - dueB || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
};

/**
 * Prochaine action d'un lead : sa première tâche ouverte (échéance la plus proche d'abord ; sans échéance en dernier).
 * `null` s'il n'y en a pas.
 */
export function nextAction(activities: readonly ActivityRow[]): ActivityRow | null {
  return activities.filter(isOpenTask).sort(byDueThenCreated)[0] ?? null;
}

/** Chronologie : la plus récente d'abord (création, puis identifiant pour un ordre stable). */
export function sortTimeline(activities: readonly ActivityRow[]): ActivityRow[] {
  return [...activities].sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
}

/** Tâches ouvertes dues, de la plus en retard à la moins en retard. */
export function dueTasks(activities: readonly ActivityRow[], now: Date): ActivityRow[] {
  return activities.filter((activity) => isDue(activity, now)).sort(byDueThenCreated);
}
