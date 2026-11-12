import { describe, expect, it } from "vitest";
import {
  crmMappingsSchema,
  decideCreate,
  resolveContactRecord,
  saveCrmMappingsSchema,
  type CrmMappingEntry,
  type InternalContactState,
} from "./index";

const UUID = "7f000000-0000-4000-8000-000000000001";
const entry = (internal_field: CrmMappingEntry["internal_field"], over: Partial<CrmMappingEntry> = {}): CrmMappingEntry => ({
  entity: "contact", internal_field, external_field: `col_${internal_field}`, source_of_truth: "internal", direction: "both", ...over,
});
const mappings = (over: Partial<Record<CrmMappingEntry["internal_field"], Partial<CrmMappingEntry>>> = {}): CrmMappingEntry[] => [
  entry("external_id", { direction: "pull" }),
  entry("name", over.name),
  entry("language", over.language),
  entry("country", over.country),
];
const internal = (over: Partial<InternalContactState> = {}): InternalContactState => ({
  id: UUID, fields: { name: "Nadia", language: "fr", country: "MA" }, updatedAt: new Date("2026-11-10T00:00:00Z"), doNotContact: false, ...over,
});
const LAST = new Date("2026-11-05T00:00:00Z");
const record = (fields: Record<string, string | null>, updated: string | null = "2026-11-12T00:00:00Z") => ({
  externalId: "ext-1", fields: fields as never, externalUpdatedAt: updated ? new Date(updated) : null,
});

describe("mappings", () => {
  const base = [{ entity: "contact", internal_field: "external_id", external_field: "id", source_of_truth: "external", direction: "pull" }, { entity: "contact", internal_field: "name", external_field: "Nom", source_of_truth: "internal", direction: "both" }];

  it("external_id obligatoire, un mapping par champ interne et par colonne, 2 à 20 entrées", () => {
    expect(crmMappingsSchema.safeParse(base).success).toBe(true);
    expect(crmMappingsSchema.safeParse([base[1]]).success).toBe(false);
    expect(crmMappingsSchema.safeParse([base[1], { ...base[1], internal_field: "language" }]).success).toBe(false);
    expect(crmMappingsSchema.safeParse([...base, { ...base[1], external_field: "autre" }]).success).toBe(false);
    expect(crmMappingsSchema.safeParse([...base, { ...base[1], internal_field: "language" }]).success).toBe(false);
    expect(crmMappingsSchema.safeParse(base.slice(0, 1)).success).toBe(false);
  });

  it("champs techniques en lecture seulement ; champ interne hors liste blanche et entité inconnue refusés", () => {
    expect(crmMappingsSchema.safeParse([{ ...base[0], direction: "both" }, base[1]]).success).toBe(false);
    expect(crmMappingsSchema.safeParse([base[0], { ...base[1], internal_field: "do_not_contact" }]).success).toBe(false);
    expect(crmMappingsSchema.safeParse([base[0], { ...base[1], internal_field: "consent_status" }]).success).toBe(false);
    expect(crmMappingsSchema.safeParse([base[0], { ...base[1], entity: "deal" }]).success).toBe(false);
    expect(crmMappingsSchema.safeParse([base[0], { ...base[1], extra: 1 }]).success).toBe(false);
  });

  it("nom de colonne externe : texte court sans contrôle ni espace de bordure", () => {
    for (const external_field of ["", " Nom", "Nom ", "a؜b", "x".repeat(101)]) expect(crmMappingsSchema.safeParse([base[0], { ...base[1], external_field }]).success, external_field).toBe(false);
    expect(crmMappingsSchema.safeParse([base[0], { ...base[1], external_field: "Nom complet (FR)" }]).success).toBe(true);
  });

  it("enregistrement : l'entreprise n'est jamais acceptée dans le corps", () => {
    expect(saveCrmMappingsSchema.safeParse({ integration_id: UUID, mappings: base }).success).toBe(true);
    expect(saveCrmMappingsSchema.safeParse({ integration_id: UUID, mappings: base, organization_id: UUID }).success).toBe(false);
  });
});

describe("decideCreate", () => {
  it("normalise comme un contact saisi (e-mail brut conservé, téléphone E.164, langue, pays)", () => {
    expect(decideCreate({ externalId: "e1", fields: { name: " Nadia ", email: "Nadia@X.ma", phone: "0612345678", language: "FR", country: "ma" }, externalUpdatedAt: null }, "MA")).toEqual({
      kind: "create", fields: { name: "Nadia", email: "Nadia@X.ma", phone: "+212612345678", language: "fr", country: "MA" },
    });
  });

  it("refus avec un motif : sans identifiant externe, sans identité, e-mail ou téléphone ou valeur invalide", () => {
    expect(decideCreate({ externalId: "", fields: { email: "a@x.ma" }, externalUpdatedAt: null })).toEqual({ kind: "invalid", reason: "no_external_id" });
    expect(decideCreate({ externalId: "e", fields: { name: "A" }, externalUpdatedAt: null })).toEqual({ kind: "invalid", reason: "no_identifier" });
    expect(decideCreate({ externalId: "e", fields: { email: "pas-un-email" }, externalUpdatedAt: null })).toEqual({ kind: "invalid", reason: "invalid_email" });
    expect(decideCreate({ externalId: "e", fields: { phone: "123" }, externalUpdatedAt: null }, "MA")).toEqual({ kind: "invalid", reason: "invalid_phone" });
    expect(decideCreate({ externalId: "e", fields: { email: "a@x.ma", language: "fra" }, externalUpdatedAt: null })).toEqual({ kind: "invalid", reason: "invalid_value" });
  });
});

describe("resolveContactRecord : règle de conflit", () => {
  it("seul le fournisseur a changé : sa valeur s'applique, aucun conflit", () => {
    const decision = resolveContactRecord(record({ name: "Nadia B." }), internal({ updatedAt: new Date("2026-11-01T00:00:00Z") }), mappings(), LAST);
    expect(decision).toEqual({ kind: "update", fields: { name: "Nadia B." }, conflicts: [] });
  });

  it("le fournisseur n'a rien de nouveau (date ancienne) : rien n'est fait, même si les valeurs diffèrent", () => {
    expect(resolveContactRecord(record({ name: "Autre" }, "2026-11-01T00:00:00Z"), internal(), mappings(), LAST)).toEqual({ kind: "skip", reason: "external_not_newer" });
  });

  it("les deux côtés ont changé et diffèrent : la source de vérité INTERNE garde sa valeur, le conflit est consigné", () => {
    expect(resolveContactRecord(record({ name: "Externe" }), internal(), mappings({ name: { source_of_truth: "internal" } }), LAST)).toEqual({
      kind: "update", fields: {}, conflicts: [{ field: "name", winner: "internal" }],
    });
  });

  it("les deux côtés ont changé : la source de vérité EXTERNE l'emporte, le conflit est consigné", () => {
    expect(resolveContactRecord(record({ name: "Externe" }), internal(), mappings({ name: { source_of_truth: "external" } }), LAST)).toEqual({
      kind: "update", fields: { name: "Externe" }, conflicts: [{ field: "name", winner: "external" }],
    });
  });

  it("la source de vérité est PAR CHAMP : nom interne, pays externe", () => {
    const decision = resolveContactRecord(record({ name: "Externe", country: "SA" }), internal(), mappings({ name: { source_of_truth: "internal" }, country: { source_of_truth: "external" } }), LAST);
    expect(decision).toEqual({ kind: "update", fields: { country: "SA" }, conflicts: [{ field: "name", winner: "internal" }, { field: "country", winner: "external" }] });
  });

  it("valeurs identiques : aucun conflit même si les deux côtés ont changé", () => {
    expect(resolveContactRecord(record({ name: "Nadia", language: "FR" }), internal(), mappings(), LAST)).toEqual({ kind: "skip", reason: "unchanged" });
  });

  it("jamais synchronisé (pas de date) : tout est tenu pour modifié des deux côtés, la source de vérité tranche", () => {
    expect(resolveContactRecord(record({ name: "Externe" }, null), internal(), mappings({ name: { source_of_truth: "external" } }), null)).toMatchObject({
      kind: "update", fields: { name: "Externe" }, conflicts: [{ field: "name", winner: "external" }],
    });
  });

  it("date du fournisseur absente : traité comme modifié (jamais d'oubli silencieux)", () => {
    expect(resolveContactRecord(record({ name: "Nouveau" }, null), internal({ updatedAt: new Date("2026-11-01T00:00:00Z") }), mappings(), LAST)).toMatchObject({ kind: "update", fields: { name: "Nouveau" } });
  });

  it("sens `push` : jamais lu depuis le fournisseur ; champ non mappé ou absent de la ligne : ignoré", () => {
    const decision = resolveContactRecord(record({ name: "Externe", country: "SA" }), internal({ updatedAt: new Date("2026-11-01T00:00:00Z") }), mappings({ name: { direction: "push" } }), LAST);
    expect(decision).toEqual({ kind: "update", fields: { country: "SA" }, conflicts: [] });
    expect(resolveContactRecord(record({}), internal(), mappings(), LAST)).toEqual({ kind: "skip", reason: "unchanged" });
  });

  it("contact « ne plus contacter » : jamais modifié par une synchro", () => {
    expect(resolveContactRecord(record({ name: "X" }), internal({ doNotContact: true }), mappings({ name: { source_of_truth: "external" } }), LAST)).toEqual({ kind: "skip", reason: "do_not_contact" });
  });

  it("valeur du fournisseur invalide : ligne refusée, jamais corrigée en silence ; cellule vide : « non fournie », n'efface jamais", () => {
    expect(resolveContactRecord(record({ language: "fra" }), internal({ updatedAt: new Date("2026-11-01T00:00:00Z") }), mappings(), LAST)).toEqual({ kind: "invalid", reason: "invalid_value" });
    expect(resolveContactRecord(record({ country: "", name: "  " }), internal({ updatedAt: new Date("2026-11-01T00:00:00Z") }), mappings({ country: { source_of_truth: "external" } }), LAST)).toEqual({ kind: "skip", reason: "unchanged" });
  });

  it("deux synchros successives : les écritures de la première (avant sa FIN) ne sont pas un changement interne, donc aucun faux conflit", () => {
    const start = new Date("2026-11-20T00:00:00Z");
    const finish = new Date("2026-11-20T00:00:30Z");
    // la synchro 1 a écrit le contact à start + 10 s (updated_at > start, < finish)
    const written = internal({ updatedAt: new Date("2026-11-20T00:00:10Z") });
    const second = record({ name: "Nom révisé" }, "2026-11-25T00:00:00Z");
    // sans le curseur de fin : faux conflit (le nom externe serait rejeté)
    expect(resolveContactRecord(second, written, mappings({ name: { source_of_truth: "internal" } }), start)).toMatchObject({ kind: "update", conflicts: [{ field: "name", winner: "internal" }] });
    // avec le curseur de fin : seul le fournisseur a changé, sa valeur s'applique
    expect(resolveContactRecord(second, written, mappings({ name: { source_of_truth: "internal" } }), start, finish)).toEqual({ kind: "update", fields: { name: "Nom révisé" }, conflicts: [] });
    // une vraie modification humaine après la fin de la synchro reste un conflit
    expect(resolveContactRecord(second, internal({ updatedAt: new Date("2026-11-22T00:00:00Z") }), mappings({ name: { source_of_truth: "internal" } }), start, finish)).toMatchObject({ conflicts: [{ field: "name", winner: "internal" }] });
  });

  it("identité (e-mail, téléphone) : jamais écrasée sur un contact existant", () => {
    const all = [...mappings(), entry("email", { direction: "pull" }), entry("phone", { direction: "pull" })];
    const decision = resolveContactRecord(record({ email: "autre@x.ma", phone: "+212600000000", name: "Nadia" }), internal({ updatedAt: new Date("2026-11-01T00:00:00Z") }), all, LAST);
    expect(decision).toEqual({ kind: "skip", reason: "unchanged" });
  });
});
