import { describe, expect, it } from "vitest";
import { MemoryCrm } from "./crm-sync.testkit";
import { NonRetryableError } from "./errors";
import { createCrmSyncHandler, type JobContext } from "./handlers";

const ORG = "11111111-1111-4111-8111-111111111111";
const INTEGRATION = "77777777-7777-4777-8777-777777777777";
const BATCH = "66666666-6666-4666-8666-666666666666";
const ctx = (over: Partial<JobContext> = {}): JobContext => ({
  jobId: "44444444-4444-4444-8444-444444444444", organizationId: ORG, idempotencyKey: "k", attempt: 1, maxAttempts: 3, signal: new AbortController().signal, ...over,
});
const csv = (text: string) => new TextEncoder().encode(text);
const HEADER = "ID,Nom,E-mail,Pays,Modifié le";
const run = (gateway: MemoryCrm, over: Partial<JobContext> = {}) =>
  createCrmSyncHandler(gateway).run(ctx(over), { integration_id: INTEGRATION, batch_id: BATCH });

describe("crm_sync : charge utile", () => {
  it("identifiants seulement (aucune entreprise, aucune donnée)", () => {
    const handler = createCrmSyncHandler(new MemoryCrm());
    expect(handler.kind).toBe("crm_sync");
    expect(handler.parse({ integration_id: INTEGRATION, batch_id: BATCH }).success).toBe(true);
    expect(handler.parse({ integration_id: INTEGRATION }).success).toBe(false);
    expect(handler.parse({ integration_id: INTEGRATION, batch_id: BATCH, organization_id: ORG }).success).toBe(false);
    expect(handler.parse({ integration_id: INTEGRATION, batch_id: BATCH, rows: [] }).success).toBe(false);
  });
});

describe("crm_sync : création, rattachement, mise à jour", () => {
  it("crée les nouveaux contacts (identité obligatoire), refuse les lignes sans identité ou invalides, compte tout", async () => {
    const crm = new MemoryCrm();
    crm.file = csv(`${HEADER}\ne1,Nadia,nadia@x.ma,MA,2026-11-12\ne2,Sans mail,,MA,2026-11-12\ne3,Mauvais,pas-un-email,MA,2026-11-12\n,Sans id,a@x.ma,MA,\n`);
    await run(crm);
    expect(crm.contacts).toHaveLength(1);
    expect(crm.contacts[0]).toMatchObject({ externalId: "e1", name: "Nadia", email: "nadia@x.ma", country: "MA" });
    expect(crm.finished?.counts).toEqual({ created: 1, updated: 0, linked: 0, unchanged: 0, skipped: 0, rejected: 3, conflicts: 0 });
    expect(crm.finished?.batchId).toBe(BATCH);
    // l'identifiant externe est PROPRE à l'intégration (jamais partagé entre deux intégrations CSV)
    expect(new Set(crm.sources)).toEqual(new Set(["csv:77777777-7777-4777-8777-777777777777"]));
    expect(crm.finished?.startedAt).toEqual(new Date("2026-11-20T00:00:00Z"));
  });

  it("rejeu : le même fichier ne recrée rien (identifiant externe)", async () => {
    const crm = new MemoryCrm();
    crm.file = csv(`${HEADER}\ne1,Nadia,nadia@x.ma,MA,2026-11-12\n`);
    await run(crm);
    await run(crm);
    expect(crm.contacts).toHaveLength(1);
    expect(crm.finished?.counts.created).toBe(0);
    expect(crm.finished?.counts.unchanged).toBe(1);
  });

  it("rattache un contact existant (même e-mail, sans identifiant externe) sans toucher à son identité ni écraser des valeurs plus récentes", async () => {
    const crm = new MemoryCrm();
    const existing = crm.add({ name: "Nadia Benali", email: "nadia@x.ma", country: "MA", updatedAt: new Date("2026-11-10T00:00:00Z") });
    crm.file = csv(`${HEADER}\ne1,Nadia B.,nadia@x.ma,SA,2026-11-12\n`);
    await run(crm);
    expect(crm.contacts).toHaveLength(1);
    // les deux côtés ont changé depuis le 05/11 : nom = source de vérité interne (gardé), pays = externe (appliqué)
    expect(existing).toMatchObject({ externalId: "e1", name: "Nadia Benali", country: "SA", email: "nadia@x.ma" });
    expect(crm.conflicts).toEqual([{ contactId: existing.id, conflicts: [{ field: "name", winner: "internal" }, { field: "country", winner: "external" }] }]);
    expect(crm.finished?.counts).toMatchObject({ linked: 1, conflicts: 2 });
  });

  it("un seul côté a changé : la valeur du fournisseur s'applique sans conflit", async () => {
    const crm = new MemoryCrm();
    const contact = crm.add({ externalId: "e1", name: "Ancien", email: "a@x.ma", country: "MA", updatedAt: new Date("2026-11-01T00:00:00Z") });
    crm.file = csv(`${HEADER}\ne1,Nouveau nom,a@x.ma,MA,2026-11-12\n`);
    await run(crm);
    expect(contact.name).toBe("Nouveau nom");
    expect(crm.conflicts).toEqual([]);
    expect(crm.finished?.counts).toMatchObject({ updated: 1, conflicts: 0 });
  });

  it("fournisseur sans nouveauté (date ancienne) : rien n'est modifié", async () => {
    const crm = new MemoryCrm();
    const contact = crm.add({ externalId: "e1", name: "Interne", email: "a@x.ma" });
    crm.file = csv(`${HEADER}\ne1,Autre,a@x.ma,SA,2026-10-01\n`);
    await run(crm);
    expect(contact.name).toBe("Interne");
    expect(crm.finished?.counts.unchanged).toBe(1);
  });

  it("contact « ne plus contacter » : jamais modifié ; e-mail déjà lié à un AUTRE identifiant : ligne refusée", async () => {
    const crm = new MemoryCrm();
    const stop = crm.add({ externalId: "e1", name: "Stop", email: "stop@x.ma", doNotContact: true });
    crm.add({ externalId: "autre", name: "Pris", email: "pris@x.ma" });
    crm.file = csv(`${HEADER}\ne1,Piraté,stop@x.ma,SA,2026-11-12\ne9,Vol,pris@x.ma,SA,2026-11-12\n`);
    await run(crm);
    expect(stop.name).toBe("Stop");
    expect(crm.contacts.find((c) => c.email === "pris@x.ma")?.name).toBe("Pris");
    expect(crm.finished?.counts).toMatchObject({ skipped: 1, rejected: 1 });
  });

  it("quota « contacts » plein : la ligne est refusée, la synchro continue", async () => {
    const crm = new MemoryCrm();
    crm.quotaFull = true;
    crm.file = csv(`${HEADER}\ne1,A,a@x.ma,MA,2026-11-12\ne2,B,b@x.ma,MA,2026-11-12\n`);
    await run(crm);
    expect(crm.finished?.counts).toMatchObject({ created: 0, rejected: 2 });
  });

  it("séparateur « ; », guillemets et BOM", async () => {
    const crm = new MemoryCrm();
    crm.file = csv('﻿ID;Nom;E-mail;Pays;Modifié le\ne1;"Benali; Nadia";nadia@x.ma;MA;2026-11-12\n');
    await run(crm);
    expect(crm.contacts[0]?.name).toBe("Benali; Nadia");
  });
});

describe("crm_sync : échecs", () => {
  it("fichier absent, mapping invalide, fichier mal formé : échec définitif, code enregistré", async () => {
    const missing = new MemoryCrm();
    missing.file = null;
    await expect(run(missing)).rejects.toBeInstanceOf(NonRetryableError);
    expect(missing.failed).toBe("file_missing");

    const absent = new MemoryCrm();
    absent.startResult = { status: "file_missing" };
    await expect(run(absent)).rejects.toBeInstanceOf(NonRetryableError);
    expect(absent.failed).toBe("file_missing");

    const mapping = new MemoryCrm();
    mapping.startResult = { ...(mapping.startResult as Extract<typeof mapping.startResult, { status: "running" }>), mappings: [{ nope: true }] };
    await expect(run(mapping)).rejects.toBeInstanceOf(NonRetryableError);
    expect(mapping.failed).toBe("mapping_invalid");

    const malformed = new MemoryCrm();
    malformed.file = new Uint8Array([0x49, 0x44, 0x0a, 0xff, 0xfe]);
    await expect(run(malformed)).rejects.toBeInstanceOf(NonRetryableError);
    expect(malformed.failed).toBe("file_malformed");
    const open = new MemoryCrm();
    open.file = csv('ID,Nom\n"jamais fermé,x\n');
    await expect(run(open)).rejects.toBeInstanceOf(NonRetryableError);
    expect(open.failed).toBe("file_malformed");
  });

  it("fichier SANS colonne d'identifiant (en-tête renommé) : échec « mapping_invalid », la date de synchro n'avance pas", async () => {
    const crm = new MemoryCrm();
    crm.file = csv("Identifiant,Nom,E-mail,Pays\nn1,Nadia,nadia@x.ma,MA\n");
    await expect(run(crm)).rejects.toBeInstanceOf(NonRetryableError);
    expect(crm.failed).toBe("mapping_invalid");
    expect(crm.finished).toBeNull();
    expect(crm.contacts).toHaveLength(0);
  });

  it("aucune ligne lisible (toutes sans identifiant) : échec « file_malformed », pas de synchro « réussie »", async () => {
    const crm = new MemoryCrm();
    crm.file = csv("ID,Nom,E-mail\n,A,a@x.ma\n,B,b@x.ma\n");
    await expect(run(crm)).rejects.toBeInstanceOf(NonRetryableError);
    expect(crm.failed).toBe("file_malformed");
    expect(crm.finished).toBeNull();
  });

  it("deux synchros successives : la valeur révisée du fournisseur s'applique sans faux conflit (curseur de fin)", async () => {
    const crm = new MemoryCrm();
    // la synchro 1 a écrit le contact pendant son exécution (après son DÉBUT, avant sa FIN)
    const contact = crm.add({ externalId: "e1", name: "Nom v1", email: "a@x.ma", country: "MA", updatedAt: new Date("2026-11-05T00:00:30Z") });
    crm.file = csv(`${HEADER}\ne1,Nom v2,a@x.ma,MA,2026-11-12\n`);
    await run(crm);
    expect(contact.name).toBe("Nom v2");
    expect(crm.conflicts).toEqual([]);
  });

  it("intégration inconnue ou désactivée : rien à faire, aucune erreur", async () => {
    const crm = new MemoryCrm();
    crm.startResult = { status: "missing" };
    await expect(run(crm)).resolves.toBeUndefined();
    expect(crm.finished).toBeNull();
    expect(crm.failed).toBeNull();
  });

  it("panne technique : relancée (job réessayé) ; à la dernière tentative l'échec est enregistré sur l'intégration", async () => {
    const crm = new MemoryCrm();
    crm.file = csv(`${HEADER}\ne1,A,a@x.ma,MA,2026-11-12\n`);
    crm.failFrom = "find";
    await expect(run(crm, { attempt: 1 })).rejects.toThrow("crm_sync_find_failed");
    expect(crm.failed).toBeNull();
    await expect(run(crm, { attempt: 3 })).rejects.toThrow("crm_sync_find_failed");
    expect(crm.failed).toBe("failed");
  });

  it("l'échec de l'enregistrement ne masque pas l'erreur d'origine ; signal d'arrêt : la synchro s'interrompt", async () => {
    const crm = new MemoryCrm();
    crm.file = csv(`${HEADER}\ne1,A,a@x.ma,MA,2026-11-12\n`);
    crm.failFrom = "create";
    crm.failFail = true;
    await expect(run(crm, { attempt: 3 })).rejects.toThrow("crm_sync_create_failed");
    const aborted = new AbortController();
    aborted.abort();
    const other = new MemoryCrm();
    other.file = csv(`${HEADER}\ne1,A,a@x.ma,MA,2026-11-12\n`);
    await expect(run(other, { signal: aborted.signal })).rejects.toThrow("aborted");
    expect(other.contacts).toHaveLength(0);
  });
});
