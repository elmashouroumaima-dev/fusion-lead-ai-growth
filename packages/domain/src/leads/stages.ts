import type { PipelineStageRow, StageKind } from "./schemas";

/**
 * Règles pures des étapes (J19, spec §7 et §9.1, ADR 007 E1). La base les impose aussi (déclencheurs et contraintes) ; ces
 * fonctions servent le service, l'interface et les tests.
 */

export type ClosedDates = { won_at: string | null; lost_at: string | null };

/**
 * Dates d'un deal selon le genre de l'étape où il arrive : `won` renseigne `won_at`, `lost` renseigne `lost_at`, `open` les
 * efface (réouverture). Un deal ne se place jamais dans l'étape système `unassigned`.
 */
export function closedDatesFor(kind: StageKind, now: Date): ClosedDates | null {
  switch (kind) {
    case "won":
      return { won_at: now.toISOString(), lost_at: null };
    case "lost":
      return { won_at: null, lost_at: now.toISOString() };
    case "open":
      return { won_at: null, lost_at: null };
    default:
      return null;
  }
}

const byPosition = (a: PipelineStageRow, b: PipelineStageRow) => a.position - b.position || a.id.localeCompare(b.id);

/**
 * Étape initiale d'un nouveau lead dans un pipeline : sans responsable, l'étape système `unassigned` (file « non assignés »,
 * spec §9.1) ; avec un responsable, la première étape ouverte. `null` si le pipeline n'a pas l'étape voulue.
 */
export function initialStageFor(stages: readonly PipelineStageRow[], assigneeId: string | null): PipelineStageRow | null {
  const sorted = [...stages].sort(byPosition);
  const wanted: StageKind = assigneeId === null ? "unassigned" : "open";
  return sorted.find((stage) => stage.kind === wanted) ?? null;
}

/** Un lead dans l'étape `unassigned` n'a pas de responsable (et inversement pour un lead encore ouvert). */
export function stageMatchesAssignee(kind: StageKind, assigneeId: string | null): boolean {
  return kind !== "unassigned" || assigneeId === null;
}

/** Étapes d'un pipeline dans l'ordre d'affichage (position, puis identifiant). */
export function sortStages(stages: readonly PipelineStageRow[]): PipelineStageRow[] {
  return [...stages].sort(byPosition);
}
