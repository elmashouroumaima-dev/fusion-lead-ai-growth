import {
  findDuplicate,
  type ContactRow,
  type CreateContactInput,
  type RecordConsentInput,
  type RevokeConsentInput,
  type SetDoNotContactInput,
  type UpdateContactInput,
} from "@fusion-leap/domain";
import type { ServiceErrorCode } from "../service/errors";
import type { ServerSupabase } from "../tenant/identity";
import { mapContactsDbError } from "./map-error";
import { findContactsByKeys, getContact } from "./queries";

/**
 * Opérations sur les contacts et le consentement (J18). Chaque écriture passe par une fonction SQL (SECURITY DEFINER) qui relit
 * le rôle de l'appelant, applique le quota « contacts » et journalise ; ici : déduplication (règle `findDuplicate`) puis appel
 * avec les droits de l'utilisateur. L'identifiant d'organisation vient du CONTEXTE VÉRIFIÉ, jamais de l'entrée.
 *
 * Déduplication (spec §13-3) : un identifiant qui correspond à UN contact existant le réutilise (aucune fusion des données) ;
 * l'e-mail d'un contact et le téléphone d'un AUTRE donnent `conflict` avec les identifiants concernés (revue manuelle) ; les
 * index uniques de la base ferment la course entre deux soumissions identiques (23505 -> conflict).
 */
export type ContactResult<T> = { ok: true; value: T } | { ok: false; code: ServiceErrorCode; duplicates?: string[] };

const fail = (code: ServiceErrorCode, duplicates?: string[]): { ok: false; code: ServiceErrorCode; duplicates?: string[] } =>
  duplicates ? { ok: false, code, duplicates } : { ok: false, code };

async function readBack(supabase: ServerSupabase, organizationId: string, contactId: string): Promise<ContactRow | null> {
  try {
    return await getContact(supabase, organizationId, contactId);
  } catch {
    return null;
  }
}

const contactArgs = (input: CreateContactInput | UpdateContactInput) => ({
  p_name: input.name,
  p_email_raw: input.email_raw,
  p_email_normalized: input.email_normalized,
  p_phone_e164: input.phone_e164,
  p_language: input.language,
  p_country: input.country,
  p_external_source: input.external_source,
  p_external_id: input.external_id,
  p_attributes: input.attributes,
});

/** Crée un contact, ou renvoie celui qui existe déjà (`created: false`). */
export async function createContact(
  supabase: ServerSupabase,
  organizationId: string,
  input: CreateContactInput,
): Promise<ContactResult<{ contact: ContactRow; created: boolean }>> {
  let existing: ContactRow[];
  try {
    existing = await findContactsByKeys(supabase, organizationId, input);
  } catch {
    return fail("internal_error");
  }
  const duplicate = findDuplicate(input, existing);
  if (duplicate.kind === "conflict") return fail("conflict", duplicate.ids);
  if (duplicate.kind === "match") {
    const contact = existing.find((row) => row.id === duplicate.id);
    return contact ? { ok: true, value: { contact, created: false } } : fail("internal_error");
  }

  const { data, error } = await supabase.rpc("create_contact", { p_org: organizationId, ...contactArgs(input) });
  if (error) {
    // Course perdue contre une création identique : on reprend le contact gagnant.
    if (error.code === "23505") {
      try {
        const winner = findDuplicate(input, await findContactsByKeys(supabase, organizationId, input));
        if (winner.kind === "match") {
          const contact = await readBack(supabase, organizationId, winner.id);
          if (contact) return { ok: true, value: { contact, created: false } };
        }
      } catch {
        // retombe sur le conflit
      }
    }
    return fail(mapContactsDbError(error));
  }
  if (typeof data !== "string") return fail("internal_error");
  const contact = await readBack(supabase, organizationId, data);
  return contact ? { ok: true, value: { contact, created: true } } : fail("internal_error");
}

/** Modifie un contact ; un identifiant déjà porté par UN AUTRE contact donne `conflict`. */
export async function updateContact(
  supabase: ServerSupabase,
  organizationId: string,
  input: UpdateContactInput,
): Promise<ContactResult<ContactRow>> {
  try {
    const others = (await findContactsByKeys(supabase, organizationId, input)).filter((row) => row.id !== input.contact_id);
    if (others.length > 0) return fail("conflict", others.map((row) => row.id));
  } catch {
    return fail("internal_error");
  }
  const { error } = await supabase.rpc("update_contact", { p_org: organizationId, p_id: input.contact_id, ...contactArgs(input) });
  if (error) return fail(mapContactsDbError(error));
  const contact = await readBack(supabase, organizationId, input.contact_id);
  return contact ? { ok: true, value: contact } : fail("internal_error");
}

/** Enregistre un consentement (sans effet s'il existe déjà un consentement actif pour le même canal et la même finalité). */
export async function recordConsent(
  supabase: ServerSupabase,
  organizationId: string,
  input: RecordConsentInput,
): Promise<ContactResult<{ eventId: string; contact: ContactRow }>> {
  const { data, error } = await supabase.rpc("record_consent", {
    p_org: organizationId,
    p_contact: input.contact_id,
    p_channel: input.channel,
    p_purpose: input.purpose,
    p_source: input.source,
    p_proof: input.proof,
  });
  if (error) return fail(mapContactsDbError(error));
  if (typeof data !== "string") return fail("internal_error");
  const contact = await readBack(supabase, organizationId, input.contact_id);
  return contact ? { ok: true, value: { eventId: data, contact } } : fail("internal_error");
}

/** Révoque les consentements actifs d'un canal (et d'une finalité) ; peut aussi poser « ne plus contacter ». Effet immédiat. */
export async function revokeConsent(
  supabase: ServerSupabase,
  organizationId: string,
  input: RevokeConsentInput,
): Promise<ContactResult<{ revoked: number; contact: ContactRow }>> {
  const { data, error } = await supabase.rpc("revoke_consent", {
    p_org: organizationId,
    p_contact: input.contact_id,
    p_channel: input.channel,
    p_purpose: input.purpose ?? null,
    p_do_not_contact: input.do_not_contact,
  });
  if (error) return fail(mapContactsDbError(error));
  if (typeof data !== "number") return fail("internal_error");
  const contact = await readBack(supabase, organizationId, input.contact_id);
  return contact ? { ok: true, value: { revoked: data, contact } } : fail("internal_error");
}

/** Pose ou retire « ne plus contacter » (le retrait est réservé à owner et admin par la base). */
export async function setDoNotContact(
  supabase: ServerSupabase,
  organizationId: string,
  input: SetDoNotContactInput,
): Promise<ContactResult<ContactRow>> {
  const { error } = await supabase.rpc("set_do_not_contact", { p_org: organizationId, p_contact: input.contact_id, p_value: input.value });
  if (error) return fail(mapContactsDbError(error));
  const contact = await readBack(supabase, organizationId, input.contact_id);
  return contact ? { ok: true, value: contact } : fail("internal_error");
}
