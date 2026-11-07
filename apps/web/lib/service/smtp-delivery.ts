import "server-only";
import { smtpDeliverySchema, type SmtpDelivery } from "@fusion-leap/domain";
import { createAdminClient } from "../supabase/admin";

/**
 * Configuration d'envoi SMTP de la plateforme avec le mot de passe CHIFFRÉ, lue côté serveur (service_role, fonction
 * `get_smtp_delivery`). Le déchiffrement se fait ensuite dans le module appelant avec la clé maître de
 * l'environnement serveur. `null` : aucune configuration (ou illisible, ou erreur de lecture).
 */
export async function getSmtpDelivery(): Promise<SmtpDelivery | null> {
  try {
    const { data, error } = await createAdminClient().rpc("get_smtp_delivery");
    if (error || data === null || data === undefined) return null;
    const parsed = smtpDeliverySchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
