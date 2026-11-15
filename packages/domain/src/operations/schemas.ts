import { z } from "zod";
import { uuidSchema } from "../tenant/schemas";

/**
 * Exploitation des envois (J39). L'entreprise vient du CONTEXTE VÉRIFIÉ, jamais du corps : aucun `organization_id` ici.
 */
export const emergencyStopSchema = z.object({ paused: z.boolean() }).strict();
export type EmergencyStopInput = z.infer<typeof emergencyStopSchema>;

export const replayDeadLetterSchema = z.object({ job_id: uuidSchema }).strict();
export type ReplayDeadLetterInput = z.infer<typeof replayDeadLetterSchema>;

/** Ligne de dead letter affichable : identifiants, nature, nombre de tentatives, erreur courte nettoyée. Jamais de charge utile. */
export const deadLetterRowSchema = z.object({
  id: uuidSchema,
  kind: z.string(),
  attempts: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
  finished_at: z.string().nullable(),
});
export type DeadLetterRow = z.infer<typeof deadLetterRowSchema>;
