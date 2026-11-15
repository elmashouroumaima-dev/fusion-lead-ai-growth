import { describe, expect, it } from "vitest";
import { deadLetterRowSchema, emergencyStopSchema, replayDeadLetterSchema } from "./schemas";

const ID = "a0000000-0000-4000-8000-0000000000a1";

describe("schémas d'exploitation des envois", () => {
  it("l'arrêt d'urgence exige un booléen et refuse tout champ en plus (dont organization_id)", () => {
    expect(emergencyStopSchema.safeParse({ paused: true }).success).toBe(true);
    expect(emergencyStopSchema.safeParse({ paused: "true" }).success).toBe(false);
    expect(emergencyStopSchema.safeParse({}).success).toBe(false);
    expect(emergencyStopSchema.safeParse({ paused: true, organization_id: ID }).success).toBe(false);
  });

  it("le rejeu exige un identifiant de job et rien d'autre", () => {
    expect(replayDeadLetterSchema.safeParse({ job_id: ID }).success).toBe(true);
    expect(replayDeadLetterSchema.safeParse({ job_id: "x" }).success).toBe(false);
    expect(replayDeadLetterSchema.safeParse({ job_id: ID, organization_id: ID }).success).toBe(false);
  });

  it("la ligne de dead letter ne porte pas de charge utile", () => {
    const row = deadLetterRowSchema.parse({ id: ID, kind: "send_message", attempts: 5, last_error: "provider_error", finished_at: null, payload: { secret: 1 } });
    expect(Object.keys(row)).not.toContain("payload");
  });
});
