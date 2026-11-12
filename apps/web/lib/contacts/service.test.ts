import { createContactSchema, recordConsentSchema, revokeConsentSchema, updateContactSchema, type ContactRow } from "@fusion-leap/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSupabase } from "../tenant/identity";
import { mapContactsDbError } from "./map-error";
import { createContact, recordConsent, revokeConsent, setDoNotContact, updateContact } from "./service";

const ORG = "8b000000-0000-4000-8000-00000000000a";
const A = "8c000000-0000-4000-8000-0000000000a1";
const B = "8c000000-0000-4000-8000-0000000000a2";
const NOW = "2026-11-20T10:00:00+00:00";

const row = (over: Partial<ContactRow> = {}): ContactRow => ({
  id: A, organization_id: ORG, name: "Karim", email_raw: "karim@exemple.ma", email_normalized: "karim@exemple.ma", phone_e164: "+212612345678",
  language: null, country: null, consent_status: "unknown", do_not_contact: false, external_source: null, external_id: null, attributes: {},
  created_at: NOW, updated_at: NOW, ...over,
});

/** Faux client : `from("contacts")` filtre en mémoire sur les `.eq()` ; `rpc` programmable. */
function fakeClient() {
  const state: { contacts: ContactRow[]; rpc: (name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }; failRead: boolean } = {
    contacts: [],
    rpc: () => ({ data: null, error: null }),
    failRead: false,
  };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => state.rpc(name, args));
  const from = () => {
    const filters: [string, unknown][] = [];
    const result = () => ({
      data: state.contacts.filter((contact) => filters.every(([column, value]) => (contact as unknown as Record<string, unknown>)[column] === value)),
      error: state.failRead ? { code: "XX000" } : null,
    });
    const query: Record<string, unknown> = {};
    query.select = () => query;
    query.eq = (column: string, value: unknown) => {
      filters.push([column, value]);
      return query;
    };
    query.maybeSingle = () => {
      const { data, error } = result();
      return Promise.resolve({ data: data[0] ?? null, error });
    };
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve);
    return query;
  };
  return { client: { rpc, from } as unknown as ServerSupabase, rpc, state };
}

let c: ReturnType<typeof fakeClient>;
beforeEach(() => {
  c = fakeClient();
});

const parseCreate = (raw: Record<string, unknown>) => {
  const parsed = createContactSchema.safeParse(raw);
  if (!parsed.success) throw new Error("fixture invalide");
  return parsed.data;
};

describe("createContact", () => {
  it("nouveau contact : fonction SQL appelée avec l'entreprise du CONTEXTE et les valeurs normalisées, puis relu", async () => {
    c.state.rpc = () => ({ data: B, error: null });
    c.state.contacts = [];
    // après la création, la lecture retrouve la ligne
    const created = row({ id: B, email_normalized: "neuf@x.com", phone_e164: null });
    c.rpc.mockImplementationOnce(async () => {
      c.state.contacts = [created];
      return { data: B, error: null };
    });
    const result = await createContact(c.client, ORG, parseCreate({ name: "Neuf", email: " Neuf@X.com ", organization_id: "7f000000-0000-4000-8000-0000000000ff" }));
    expect(result).toEqual({ ok: true, value: { contact: created, created: true } });
    expect(c.rpc).toHaveBeenCalledWith("create_contact", expect.objectContaining({ p_org: ORG, p_email_raw: "Neuf@X.com", p_email_normalized: "neuf@x.com", p_phone_e164: null }));
    // l'organisation revendiquée par l'entrée n'est jamais transmise
    expect(JSON.stringify(c.rpc.mock.calls[0])).not.toContain("7f000000-0000-4000-8000-0000000000ff");
  });

  it("même e-mail qu'un contact existant : on le réutilise, aucune écriture", async () => {
    c.state.contacts = [row()];
    const result = await createContact(c.client, ORG, parseCreate({ email: "KARIM@exemple.ma" }));
    expect(result).toEqual({ ok: true, value: { contact: row(), created: false } });
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it("même téléphone (autre format) : réutilisé", async () => {
    c.state.contacts = [row()];
    const result = await createContact(c.client, ORG, parseCreate({ phone: "06 12 34 56 78", default_country: "MA" }));
    expect(result.ok && result.value.created).toBe(false);
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it("e-mail d'un contact et téléphone d'un autre : conflict avec les deux identifiants, aucune écriture", async () => {
    c.state.contacts = [row(), row({ id: B, email_normalized: "layla@x.com", email_raw: "layla@x.com", phone_e164: "+966501234567" })];
    const result = await createContact(c.client, ORG, parseCreate({ email: "karim@exemple.ma", phone: "+966501234567" }));
    expect(result).toEqual({ ok: false, code: "conflict", duplicates: [A, B] });
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it("course perdue (index unique) : reprend le contact gagnant", async () => {
    const winner = row({ id: B, email_normalized: "course@x.com", email_raw: "course@x.com", phone_e164: null });
    c.rpc.mockImplementationOnce(async () => {
      c.state.contacts = [winner];
      return { data: null, error: { code: "23505", message: "duplicate key" } };
    });
    const result = await createContact(c.client, ORG, parseCreate({ email: "course@x.com" }));
    expect(result).toEqual({ ok: true, value: { contact: winner, created: false } });
  });

  it("quota atteint, rôle interdit, panne : codes normalisés", async () => {
    c.state.rpc = () => ({ data: null, error: { code: "P0001", message: "quota_exceeded" } });
    expect(await createContact(c.client, ORG, parseCreate({ email: "q@x.com" }))).toEqual({ ok: false, code: "quota_exceeded" });
    c.state.rpc = () => ({ data: null, error: { code: "42501", message: "forbidden" } });
    expect(await createContact(c.client, ORG, parseCreate({ email: "q@x.com" }))).toEqual({ ok: false, code: "forbidden" });
    c.state.rpc = () => ({ data: null, error: { code: "XX000", message: "boom" } });
    expect(await createContact(c.client, ORG, parseCreate({ email: "q@x.com" }))).toEqual({ ok: false, code: "internal_error" });
  });

  it("lecture impossible avant la création : internal_error, rien n'est écrit", async () => {
    c.state.failRead = true;
    expect(await createContact(c.client, ORG, parseCreate({ email: "q@x.com" }))).toEqual({ ok: false, code: "internal_error" });
    expect(c.rpc).not.toHaveBeenCalled();
  });
});

describe("updateContact", () => {
  const parseUpdate = (raw: Record<string, unknown>) => {
    const parsed = updateContactSchema.safeParse({ contact_id: A, ...raw });
    if (!parsed.success) throw new Error("fixture invalide");
    return parsed.data;
  };

  it("modifie et relit ; son propre e-mail n'est pas un doublon", async () => {
    c.state.contacts = [row()];
    const result = await updateContact(c.client, ORG, parseUpdate({ name: "Karim B.", email: "karim@exemple.ma" }));
    expect(result.ok).toBe(true);
    expect(c.rpc).toHaveBeenCalledWith("update_contact", expect.objectContaining({ p_org: ORG, p_id: A, p_name: "Karim B." }));
  });

  it("identifiant déjà porté par un autre contact : conflict, aucune écriture", async () => {
    c.state.contacts = [row(), row({ id: B, email_normalized: "layla@x.com", email_raw: "layla@x.com", phone_e164: "+966501234567" })];
    expect(await updateContact(c.client, ORG, parseUpdate({ phone: "+966501234567" }))).toEqual({ ok: false, code: "conflict", duplicates: [B] });
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it("contact d'une autre entreprise ou absent : not_found", async () => {
    c.state.rpc = () => ({ data: null, error: { code: "PT404", message: "not_found" } });
    expect(await updateContact(c.client, ORG, parseUpdate({ email: "z@x.com" }))).toEqual({ ok: false, code: "not_found" });
  });
});

describe("consentement", () => {
  it("enregistrement : paramètres de la fonction SQL, contact relu", async () => {
    c.state.contacts = [row({ consent_status: "granted" })];
    c.state.rpc = () => ({ data: "8d000000-0000-4000-8000-000000000001", error: null });
    const input = recordConsentSchema.parse({ contact_id: A, channel: "email", purpose: "marketing", source: "web_form", proof: { consent_version: "v2" } });
    const result = await recordConsent(c.client, ORG, input);
    expect(result.ok && result.value.contact.consent_status).toBe("granted");
    expect(c.rpc).toHaveBeenCalledWith("record_consent", {
      p_org: ORG, p_contact: A, p_channel: "email", p_purpose: "marketing", p_source: "web_form", p_proof: { consent_version: "v2" },
    });
  });

  it("révocation : nombre d'événements révoqués renvoyé ; ne-plus-contacter transmis", async () => {
    c.state.contacts = [row({ consent_status: "revoked", do_not_contact: true })];
    c.state.rpc = () => ({ data: 2, error: null });
    const result = await revokeConsent(c.client, ORG, revokeConsentSchema.parse({ contact_id: A, channel: "whatsapp", do_not_contact: true }));
    expect(result.ok && result.value.revoked).toBe(2);
    expect(c.rpc).toHaveBeenCalledWith("revoke_consent", { p_org: ORG, p_contact: A, p_channel: "whatsapp", p_purpose: null, p_do_not_contact: true });
  });

  it("retrait de ne-plus-contacter par un rôle non autorisé : forbidden", async () => {
    c.state.rpc = () => ({ data: null, error: { code: "42501", message: "forbidden" } });
    expect(await setDoNotContact(c.client, ORG, { contact_id: A, value: false })).toEqual({ ok: false, code: "forbidden" });
  });
});

describe("mapContactsDbError", () => {
  it.each([
    [{ code: "23505" }, "conflict"],
    [{ code: "23514" }, "validation_failed"],
    [{ code: "23503" }, "validation_failed"],
    [{ code: "PT404" }, "not_found"],
    [{ code: "42501" }, "forbidden"],
    [{ code: "28000" }, "unauthenticated"],
    [{ code: "P0001", message: "quota_exceeded" }, "quota_exceeded"],
    [{ code: "P0001", message: "subscription_inactive" }, "quota_exceeded"],
    [{ code: "XX000" }, "internal_error"],
    [null, "internal_error"],
  ] as const)("%j -> %s", (error, expected) => {
    expect(mapContactsDbError(error)).toBe(expected);
  });
});
