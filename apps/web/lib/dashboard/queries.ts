import type { ServerSupabase } from "../tenant/identity";

/**
 * Compteurs d'affichage du tableau de bord, lus avec les droits de l'utilisateur (client serveur + RLS : le commercial ne compte
 * que ses leads, l'analyste aucun). Le filtre `organization_id` est explicite (défense en profondeur). Lecture d'affichage :
 * une erreur donne `null` (la carte est alors masquée), jamais une exception ni un faux zéro.
 */
export type DashboardCounts = {
  projects: number | null;
  leads: number | null;
  dealsWon: number | null;
  dealsOpen: number | null;
};

async function countRows(run: () => PromiseLike<{ count: number | null; error: unknown }>): Promise<number | null> {
  try {
    const { count, error } = await run();
    return error || typeof count !== "number" ? null : count;
  } catch {
    return null;
  }
}

export async function getDashboardCounts(
  supabase: ServerSupabase,
  organizationId: string,
  access: { projects: boolean; leads: boolean; deals: boolean },
): Promise<DashboardCounts> {
  const head = { count: "exact", head: true } as const;
  const [projects, leads, dealsWon, dealsOpen] = await Promise.all([
    access.projects
      ? countRows(() => supabase.from("projects").select("id", head).eq("organization_id", organizationId))
      : Promise.resolve(null),
    access.leads
      ? countRows(() => supabase.from("leads").select("id", head).eq("organization_id", organizationId))
      : Promise.resolve(null),
    access.deals
      ? countRows(() =>
          supabase.from("deals").select("id", head).eq("organization_id", organizationId).not("won_at", "is", null),
        )
      : Promise.resolve(null),
    access.deals
      ? countRows(() =>
          supabase
            .from("deals")
            .select("id", head)
            .eq("organization_id", organizationId)
            .is("won_at", null)
            .is("lost_at", null),
        )
      : Promise.resolve(null),
  ]);
  return { projects, leads, dealsWon, dealsOpen };
}

/** Moment de la journée (matin / après-midi / soir) dans le fuseau de l'organisation ; « morning » si le fuseau est illisible. */
export function dayPart(now: Date, timeZone: string): "morning" | "afternoon" | "evening" {
  let hour = now.getUTCHours();
  try {
    hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone }).format(now));
  } catch {
    // Fuseau inconnu : on garde l'heure UTC.
  }
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  return "evening";
}
