import { randomUUID } from "node:crypto";
import type { LeadAssigner } from "../../../apps/worker/src/assignment";
import { createLeadAssignHandler } from "../../../apps/worker/src/handlers";
import { api, psql } from "../../../supabase/tests/rls/src/harness";

/**
 * Worker d'assignation pour les scénarios d'acceptation : passerelle de test (mêmes fonctions SQL que le worker, rôle service_role)
 * et exécution du VRAI handler `lead.assign`. Partagé par `t2-sales` (J26) et `g2-lead-to-deal` (J27).
 */
const assigner: LeadAssigner = {
  async assign(org, lead) {
    const result = await api<Record<string, unknown>>("service", "POST", "rpc/auto_assign_lead", { p_org: org, p_lead: lead });
    if (result.status >= 300) throw new Error("assignment_assign_failed");
    return result.body as never;
  },
  async flagUnassigned(org, lead) {
    await api("service", "POST", "rpc/flag_lead_unassigned", { p_org: org, p_lead: lead });
  },
};
const assignHandler = createLeadAssignHandler(assigner);

const lines = (out: string): string[] => out.split(/\r?\n/).filter(Boolean);

/** Responsable de chaque lead donné (une seule requête), dans l'ordre demandé ; chaîne vide = non assigné. */
export function assigneesOf(leads: string[]): string[] {
  const out = psql(`select id || ':' || coalesce(assignee_id::text, '') from public.leads where id in (${leads.map((l) => `'${l}'`).join(",")})`);
  const rows = new Map(lines(out).map((r) => [r.slice(0, 36), r.slice(37)] as const));
  return leads.map((l) => rows.get(l) ?? "?");
}

/** Entreprise de la LIGNE de chaque job `lead.assign` (une seule requête) : jamais la charge utile. */
export function jobOrganizations(): Map<string, string> {
  const out = psql(`select (payload ->> 'lead_id') || ':' || organization_id from public.jobs where kind = 'lead.assign'`);
  return new Map(lines(out).map((r) => [r.slice(0, 36), r.slice(37)] as const));
}

/** Ce que fait le worker pour les jobs `lead.assign` : le VRAI handler, un job après l'autre, dans l'ordre. Renvoie le responsable de chaque lead. */
export async function assignAll(leads: string[]): Promise<string[]> {
  const orgs = jobOrganizations();
  for (const lead of leads) {
    const organizationId = orgs.get(lead);
    if (!organizationId) throw new Error(`job lead.assign absent pour ${lead}`);
    await assignHandler.run(
      { jobId: randomUUID(), organizationId, idempotencyKey: `lead.assign:${lead}`, attempt: 1, maxAttempts: 5, signal: new AbortController().signal },
      { lead_id: lead },
    );
  }
  return assigneesOf(leads);
}
