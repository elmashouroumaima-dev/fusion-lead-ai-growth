import { consentEventRowSchema, contactRowSchema, type ConsentEventRow, type ContactRow } from "@fusion-leap/domain";
import type { ServerSupabase } from "../tenant/identity";

/**
 * Lectures des contacts et de leur historique de consentement, faites avec les droits de l'utilisateur (client serveur + RLS :
 * owner, admin et marketing seulement ; aucune `service_role`). Le filtre `organization_id` est explicite (défense en
 * profondeur). Toute ligne illisible lève une erreur générique. Les valeurs de recherche passent par `.eq()` (jamais dans une
 * chaîne de filtre).
 */
const CONTACT_COLUMNS =
  "id, organization_id, name, email_raw, email_normalized, phone_e164, language, country, consent_status, do_not_contact, external_source, external_id, attributes, created_at, updated_at";
const CONSENT_COLUMNS = "id, organization_id, contact_id, channel, purpose, source, proof, captured_at, revoked_at";

function parseRows<T>(data: unknown, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }): T[] {
  if (!Array.isArray(data)) throw new Error("rows_unreadable");
  return data.map((row: unknown) => {
    const parsed = schema.safeParse(row);
    if (!parsed.success) throw new Error("rows_unreadable");
    return parsed.data;
  });
}

export const CONTACTS_PAGE_SIZE = 50;

export async function listContacts(
  supabase: ServerSupabase,
  organizationId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<ContactRow[]> {
  const limit = Math.min(Math.max(options.limit ?? CONTACTS_PAGE_SIZE, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const { data, error } = await supabase
    .from("contacts")
    .select(CONTACT_COLUMNS)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw new Error("contacts_lookup_failed");
  return parseRows(data, contactRowSchema);
}

/** Un contact de l'entreprise, ou `null` s'il n'existe pas (ou n'est pas visible pour ce rôle). */
export async function getContact(supabase: ServerSupabase, organizationId: string, contactId: string): Promise<ContactRow | null> {
  const { data, error } = await supabase
    .from("contacts")
    .select(CONTACT_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("id", contactId)
    .maybeSingle();
  if (error) throw new Error("contacts_lookup_failed");
  if (!data) return null;
  return parseRows([data], contactRowSchema)[0] ?? null;
}

/** Contacts de l'entreprise ayant cet e-mail normalisé ou ce téléphone E.164 (deux lectures `.eq()`, résultat dédoublonné). */
export async function findContactsByKeys(
  supabase: ServerSupabase,
  organizationId: string,
  keys: { email_normalized: string | null; phone_e164: string | null },
): Promise<ContactRow[]> {
  const found = new Map<string, ContactRow>();
  for (const [column, value] of [
    ["email_normalized", keys.email_normalized],
    ["phone_e164", keys.phone_e164],
  ] as const) {
    if (value === null) continue;
    const { data, error } = await supabase.from("contacts").select(CONTACT_COLUMNS).eq("organization_id", organizationId).eq(column, value);
    if (error) throw new Error("contacts_lookup_failed");
    for (const row of parseRows(data, contactRowSchema)) found.set(row.id, row);
  }
  return [...found.values()];
}

/** Historique de consentement d'un contact (le plus récent d'abord). */
export async function listConsentEvents(supabase: ServerSupabase, organizationId: string, contactId: string): Promise<ConsentEventRow[]> {
  const { data, error } = await supabase
    .from("consent_events")
    .select(CONSENT_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .order("captured_at", { ascending: false })
    .order("id", { ascending: true });
  if (error) throw new Error("consent_lookup_failed");
  return parseRows(data, consentEventRowSchema);
}
