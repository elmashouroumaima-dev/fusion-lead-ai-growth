import { normalizeContactEmail, normalizePhone } from "../contacts";
import { isSafeText } from "../projects/text";
import type { CrmMappingEntry, CrmUpdatableField } from "./mapping";

/**
 * Moteur de synchro d'un contact (J25) : décide, SANS effet de bord, ce qu'une ligne du fournisseur change dans le CRM interne.
 *
 * Règle de conflit (spec §9.1 : `source_of_truth` par champ + date de dernière modification) :
 *  - un champ n'est en CONFLIT que si les DEUX côtés ont changé depuis la dernière synchro ET que leurs valeurs diffèrent ;
 *  - un seul côté a changé : ce côté s'applique ; rien n'a changé du côté du fournisseur : rien à faire ;
 *  - conflit : le côté désigné par `source_of_truth` gagne ; le PERDANT est renvoyé (`conflicts`) pour être consigné dans l'audit
 *    (nom du champ et gagnant seulement, jamais la valeur) ;
 *  - un champ dont le sens est `push` n'est jamais lu depuis le fournisseur ;
 *  - l'identité (e-mail, téléphone) ne sert qu'à créer ou rattacher : elle n'écrase jamais un contact existant ;
 *  - un contact « ne plus contacter » n'est jamais modifié par une synchro ;
 *  - aucune synchro ne touche aux consentements.
 */
export type ExternalContactRecord = {
  externalId: string;
  /** Valeurs lues par le mapping, déjà débarrassées des espaces ; absent ou vide = non renseigné. */
  fields: Partial<Record<CrmUpdatableField | "email" | "phone", string | null>>;
  /** Date de dernière modification chez le fournisseur, `null` si le fichier n'en fournit pas. */
  externalUpdatedAt: Date | null;
};

export type InternalContactState = {
  id: string;
  fields: Record<CrmUpdatableField, string | null>;
  updatedAt: Date;
  doNotContact: boolean;
};

export type SyncConflict = { field: CrmUpdatableField; winner: "internal" | "external" };

export type ContactSyncDecision =
  | { kind: "invalid"; reason: "no_external_id" | "no_identifier" | "invalid_email" | "invalid_phone" | "invalid_value" }
  | { kind: "create"; fields: { name: string | null; email: string | null; phone: string | null; language: string | null; country: string | null } }
  | { kind: "skip"; reason: "do_not_contact" | "unchanged" | "external_not_newer" }
  | { kind: "update"; fields: Partial<Record<CrmUpdatableField, string | null>>; conflicts: SyncConflict[] };

const UPDATABLE: readonly CrmUpdatableField[] = ["name", "language", "country"];

function normalizeValue(field: CrmUpdatableField, value: string | null | undefined): { ok: true; value: string | null } | { ok: false } {
  const text = (value ?? "").trim();
  if (text.length === 0) return { ok: true, value: null };
  if (field === "name") return isSafeText(text, 1, 200) ? { ok: true, value: text } : { ok: false };
  if (field === "language") return /^[a-z]{2}$/i.test(text) ? { ok: true, value: text.toLowerCase() } : { ok: false };
  return /^[a-z]{2}$/i.test(text) ? { ok: true, value: text.toUpperCase() } : { ok: false };
}

/** Création : les champs normalisés (mêmes règles que les contacts saisis), identité obligatoire (e-mail ou téléphone valide). */
export function decideCreate(record: ExternalContactRecord, defaultCountry: string | null = null): ContactSyncDecision {
  if (!record.externalId) return { kind: "invalid", reason: "no_external_id" };
  const rawEmail = (record.fields.email ?? "").trim();
  const rawPhone = (record.fields.phone ?? "").trim();
  let email: string | null = null;
  let phone: string | null = null;
  if (rawEmail) {
    const parsed = normalizeContactEmail(rawEmail);
    if (!parsed.ok) return { kind: "invalid", reason: "invalid_email" };
    email = rawEmail;
  }
  if (rawPhone) {
    const parsed = normalizePhone(rawPhone, defaultCountry ?? undefined);
    if (!parsed.ok) return { kind: "invalid", reason: "invalid_phone" };
    phone = parsed.value;
  }
  if (email === null && phone === null) return { kind: "invalid", reason: "no_identifier" };
  const out = { name: null as string | null, language: null as string | null, country: null as string | null };
  for (const field of UPDATABLE) {
    const normalized = normalizeValue(field, record.fields[field]);
    if (!normalized.ok) return { kind: "invalid", reason: "invalid_value" };
    out[field] = normalized.value;
  }
  return { kind: "create", fields: { ...out, email, phone } };
}

/**
 * Mise à jour d'un contact existant déjà rattaché (même `external_id`). `lastSyncAt` : DÉBUT de la dernière synchro réussie (curseur
 * côté fournisseur) ; `internalSyncedAt` : FIN de cette synchro (curseur côté interne : les écritures de la synchro elle-même ont eu lieu
 * avant et ne comptent pas comme une modification humaine). `null` = jamais synchronisé : tout est tenu pour modifié des deux côtés, donc
 * la `source_of_truth` tranche.
 */
export function resolveContactRecord(
  record: ExternalContactRecord,
  internal: InternalContactState,
  mappings: readonly CrmMappingEntry[],
  lastSyncAt: Date | null,
  internalSyncedAt: Date | null = lastSyncAt,
): ContactSyncDecision {
  if (!record.externalId) return { kind: "invalid", reason: "no_external_id" };
  if (internal.doNotContact) return { kind: "skip", reason: "do_not_contact" };

  const externalChanged = lastSyncAt === null || record.externalUpdatedAt === null || record.externalUpdatedAt.getTime() > lastSyncAt.getTime();
  const internalChanged = internalSyncedAt === null || internal.updatedAt.getTime() > internalSyncedAt.getTime();
  if (!externalChanged) return { kind: "skip", reason: "external_not_newer" };

  const fields: Partial<Record<CrmUpdatableField, string | null>> = {};
  const conflicts: SyncConflict[] = [];
  for (const entry of mappings) {
    if (entry.entity !== "contact" || !(UPDATABLE as readonly string[]).includes(entry.internal_field)) continue;
    if (entry.direction === "push") continue;
    const field = entry.internal_field as CrmUpdatableField;
    if (!(field in record.fields)) continue;
    // Revue sécurité : une cellule VIDE est « non fournie » : elle n'efface jamais une valeur interne.
    if ((record.fields[field] ?? "").trim().length === 0) continue;
    const incoming = normalizeValue(field, record.fields[field]);
    if (!incoming.ok) return { kind: "invalid", reason: "invalid_value" };
    if (incoming.value === internal.fields[field]) continue;
    if (internalChanged) {
      // les deux côtés ont changé et diffèrent : la source de vérité du champ tranche, le perdant est consigné
      if (entry.source_of_truth === "external") {
        fields[field] = incoming.value;
        conflicts.push({ field, winner: "external" });
      } else {
        conflicts.push({ field, winner: "internal" });
      }
    } else {
      fields[field] = incoming.value;
    }
  }
  if (Object.keys(fields).length === 0 && conflicts.length === 0) return { kind: "skip", reason: "unchanged" };
  return { kind: "update", fields, conflicts };
}
