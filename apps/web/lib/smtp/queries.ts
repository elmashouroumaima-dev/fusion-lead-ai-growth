import { smtpSettingsViewSchema, type SmtpSettingsView } from "@fusion-leap/domain";
import { createClient } from "../supabase/server";

/**
 * Paramètres SMTP pour l'administrateur de la plateforme (lecture sous ses droits : la base refuse tout autre
 * appelant). Jamais le mot de passe : seulement `has_password`. Aucune ligne, refus ou valeur illisible => `null`.
 */
export async function getSmtpSettings(): Promise<SmtpSettingsView | null> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("get_smtp_settings");
    if (error || data === null || data === undefined) return null;
    const parsed = smtpSettingsViewSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
