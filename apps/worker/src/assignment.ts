import { createClient } from "@supabase/supabase-js";
import { autoAssignResultSchema, type AutoAssignResult } from "@fusion-leap/domain";

/**
 * Accès du worker à l'assignation (J22). Une seule implémentation de production (RPC Supabase, clé service_role, fonctions SQL
 * réservées à ce rôle) ; les tests injectent une version en mémoire. L'entreprise est TOUJOURS celle de la ligne du job.
 */
export interface LeadAssigner {
  assign(organizationId: string, leadId: string): Promise<AutoAssignResult>;
  /** Alerte les owner et admin qu'un lead est resté « non assigné » après un échec définitif. */
  flagUnassigned(organizationId: string, leadId: string): Promise<void>;
}

export class AssignmentError extends Error {
  constructor(operation: string) {
    super(`assignment_${operation}_failed`);
    this.name = "AssignmentError";
  }
}

export type AssignerEnv = { SUPABASE_URL: string; SUPABASE_SECRET_KEY: string };

/** Les erreurs de transport ne transportent ni URL, ni clé, ni message SQL. */
export function createSupabaseLeadAssigner(env: AssignerEnv): LeadAssigner {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    async assign(organizationId, leadId) {
      const { data, error } = await client.rpc("auto_assign_lead", { p_org: organizationId, p_lead: leadId });
      if (error) throw new AssignmentError("assign");
      const parsed = autoAssignResultSchema.safeParse(data);
      if (!parsed.success) throw new AssignmentError("assign");
      return parsed.data;
    },
    async flagUnassigned(organizationId, leadId) {
      const { error } = await client.rpc("flag_lead_unassigned", { p_org: organizationId, p_lead: leadId });
      if (error) throw new AssignmentError("flag");
    },
  };
}
