import { CrmSyncGatewayError, type CrmCounts, type CrmCreateInput, type CrmFailCode, type CrmFound, type CrmSyncGateway, type CrmSyncStart, type CrmWriteStatus } from "./crm-sync";

export type MemContact = {
  id: string;
  externalId: string | null;
  name: string | null;
  email: string | null;
  language: string | null;
  country: string | null;
  updatedAt: Date;
  doNotContact: boolean;
};

const MAPPINGS = [
  { entity: "contact", internal_field: "external_id", external_field: "ID", source_of_truth: "external", direction: "pull" },
  { entity: "contact", internal_field: "external_updated_at", external_field: "Modifié le", source_of_truth: "external", direction: "pull" },
  { entity: "contact", internal_field: "email", external_field: "E-mail", source_of_truth: "internal", direction: "pull" },
  { entity: "contact", internal_field: "name", external_field: "Nom", source_of_truth: "internal", direction: "both" },
  { entity: "contact", internal_field: "country", external_field: "Pays", source_of_truth: "external", direction: "both" },
];

/** Passerelle de synchro en mémoire pour les tests : reproduit la logique des fonctions SQL (liaison par identifiant externe, identité jamais écrasée). */
export class MemoryCrm implements CrmSyncGateway {
  startResult: CrmSyncStart = {
    status: "running", path: "org/batch.csv", provider: "csv", source: "csv:77777777-7777-4777-8777-777777777777", lastSyncAt: new Date("2026-11-05T00:00:00Z"),
    lastSyncFinishedAt: new Date("2026-11-05T00:01:00Z"), startedAt: new Date("2026-11-20T00:00:00Z"), mappings: MAPPINGS,
  };
  file: Uint8Array | null = new TextEncoder().encode("ID,Nom,E-mail,Pays,Modifié le\n");
  readonly contacts: MemContact[] = [];
  readonly conflicts: Array<{ contactId: string; conflicts: Array<{ field: string; winner: string }> }> = [];
  finished: { batchId: string; startedAt: Date; counts: CrmCounts } | null = null;
  readonly sources: string[] = [];
  failed: CrmFailCode | null = null;
  failFrom: "find" | "create" | "update" | null = null;
  failFail = false;
  quotaFull = false;
  private next = 1;

  add(partial: Partial<MemContact>): MemContact {
    const contact: MemContact = {
      id: `00000000-0000-4000-8000-${String(this.next++).padStart(12, "0")}`, externalId: null, name: null, email: null, language: null, country: null,
      updatedAt: new Date("2026-11-01T00:00:00Z"), doNotContact: false, ...partial,
    };
    this.contacts.push(contact);
    return contact;
  }

  async start(): Promise<CrmSyncStart> {
    return this.startResult;
  }
  async readFile(): Promise<Uint8Array | null> {
    return this.file;
  }
  async find(_org: string, provider: string, externalId: string, emailNormalized: string | null): Promise<CrmFound> {
    this.sources.push(provider);
    if (this.failFrom === "find") throw new CrmSyncGatewayError("find");
    let contact = this.contacts.find((c) => c.externalId === externalId);
    const linked = contact !== undefined;
    if (!contact && emailNormalized) contact = this.contacts.find((c) => c.email === emailNormalized);
    if (!contact) return null;
    if (!linked && contact.externalId !== null) return { status: "identity_taken" };
    return { status: "found", linked, id: contact.id, name: contact.name, language: contact.language, country: contact.country, updatedAt: contact.updatedAt, doNotContact: contact.doNotContact };
  }
  async create(_org: string, _provider: string, input: CrmCreateInput): Promise<{ status: CrmWriteStatus }> {
    if (this.failFrom === "create") throw new CrmSyncGatewayError("create");
    if (this.contacts.some((c) => c.externalId === input.externalId)) return { status: "exists" };
    if (this.quotaFull) return { status: "quota_exceeded" };
    this.add({ externalId: input.externalId, name: input.name, email: input.emailNormalized, language: input.language, country: input.country });
    return { status: "created" };
  }
  async update(_org: string, contactId: string, _provider: string, externalId: string, fields: Record<string, string | null>): Promise<{ status: CrmWriteStatus }> {
    if (this.failFrom === "update") throw new CrmSyncGatewayError("update");
    const contact = this.contacts.find((c) => c.id === contactId);
    if (!contact) return { status: "not_found" };
    if (contact.doNotContact) return { status: "do_not_contact" };
    if (contact.externalId !== null && contact.externalId !== externalId) return { status: "identity_taken" };
    Object.assign(contact, fields, { externalId: contact.externalId ?? externalId });
    return { status: "updated" };
  }
  async auditConflict(_org: string, _integration: string, contactId: string, conflicts: Array<{ field: string; winner: string }>): Promise<void> {
    this.conflicts.push({ contactId, conflicts });
  }
  async finish(_org: string, _integration: string, batchId: string, startedAt: Date, counts: CrmCounts): Promise<void> {
    this.finished = { batchId, startedAt, counts };
  }
  async fail(_org: string, _integration: string, code: CrmFailCode): Promise<void> {
    if (this.failFail) throw new CrmSyncGatewayError("fail");
    this.failed = code;
  }
}
