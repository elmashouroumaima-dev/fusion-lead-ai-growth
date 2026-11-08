/**
 * Déduplication à l'intérieur d'UNE entreprise (J18, spec §7 et §13-3, ADR 007). Règle pure ; la base garantit l'unicité par
 * des index uniques partiels (aucune course entre deux soumissions identiques ne crée deux contacts).
 *
 *  - l'e-mail ou le téléphone correspond à UN seul contact existant : `match` (on réutilise ce contact) ;
 *  - l'e-mail correspond à un contact et le téléphone à un AUTRE : `conflict` (jamais de fusion automatique) ;
 *  - aucun identifiant ne correspond : `none`.
 */
export type ContactKeys = { email_normalized: string | null; phone_e164: string | null };
export type ExistingContact = ContactKeys & { id: string };

export type DuplicateResult = { kind: "none" } | { kind: "match"; id: string } | { kind: "conflict"; ids: string[] };

export function findDuplicate(candidate: ContactKeys, existing: readonly ExistingContact[]): DuplicateResult {
  const ids = new Set<string>();
  for (const contact of existing) {
    const sameEmail = candidate.email_normalized !== null && contact.email_normalized === candidate.email_normalized;
    const samePhone = candidate.phone_e164 !== null && contact.phone_e164 === candidate.phone_e164;
    if (sameEmail || samePhone) ids.add(contact.id);
  }
  if (ids.size === 0) return { kind: "none" };
  const [first] = [...ids];
  if (ids.size === 1 && first !== undefined) return { kind: "match", id: first };
  return { kind: "conflict", ids: [...ids] };
}
