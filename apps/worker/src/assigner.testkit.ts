import type { AutoAssignResult } from "@fusion-leap/domain";
import type { LeadAssigner } from "./assignment";

/** Assigneur en mémoire pour les tests : enregistre les appels, peut échouer à la demande. */
export class MemoryAssigner implements LeadAssigner {
  readonly assigned: Array<{ organizationId: string; leadId: string }> = [];
  readonly flagged: Array<{ organizationId: string; leadId: string }> = [];
  result: AutoAssignResult = { outcome: "assigned", assignee_id: "22222222-2222-4222-8222-222222222222" };
  failAssign = false;
  failFlag = false;

  async assign(organizationId: string, leadId: string): Promise<AutoAssignResult> {
    this.assigned.push({ organizationId, leadId });
    if (this.failAssign) throw new Error("assignment_assign_failed");
    return this.result;
  }

  async flagUnassigned(organizationId: string, leadId: string): Promise<void> {
    this.flagged.push({ organizationId, leadId });
    if (this.failFlag) throw new Error("assignment_flag_failed");
  }
}
