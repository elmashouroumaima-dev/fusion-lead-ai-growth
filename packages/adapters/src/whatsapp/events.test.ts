import { describe, expect, it } from "vitest";
import { normalizeWhatsAppPayload as normalize, readWhatsAppPayload as read, WHATSAPP_TEXT_MAX } from "./events";

const PHONE = "106540352242922";
const wrap = (value: Record<string, unknown>, field = "messages") => ({
  object: "whatsapp_business_account",
  entry: [{ id: "102290129340398", changes: [{ field, value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550783881", phone_number_id: PHONE }, ...value } }] }],
});
const message = (patch: Record<string, unknown> = {}) => ({ from: "212600000000", id: "wamid.HBgLMjEyNjAwMDAwMDAVAgASGBQ", timestamp: "1700000000", text: { body: "Bonjour" }, type: "text", ...patch });
const status = (patch: Record<string, unknown> = {}) => ({ id: "wamid.OUT1", status: "delivered", timestamp: "1700000100", recipient_id: "212600000000", ...patch });

describe("normalisation des événements WhatsApp (J35)", () => {
  it("message texte : numéro en E.164, texte, horodatage ISO ; profil du contact et médias ne sont PAS conservés", () => {
    const out = normalize(wrap({ contacts: [{ profile: { name: "Nadia Secret" }, wa_id: "212600000000" }], messages: [message()] }));
    expect(out).toEqual({
      object: "whatsapp_business_account", phoneNumberIds: [PHONE], skipped: 0,
      events: [{ kind: "message", id: "wamid.HBgLMjEyNjAwMDAwMDAVAgASGBQ", from: "+212600000000", at: "2023-11-14T22:13:20.000Z", type: "text", text: "Bonjour" }],
    });
    expect(JSON.stringify(out)).not.toContain("Nadia Secret");
  });

  it("message non textuel : seulement son type (aucun média, aucune légende)", () => {
    const out = normalize(wrap({ messages: [message({ type: "image", text: undefined, image: { id: "MEDIA", caption: "légende", sha256: "x" } })] }));
    expect(out?.events[0]).toMatchObject({ kind: "message", type: "image", text: null });
    expect(JSON.stringify(out)).not.toContain("MEDIA");
    expect(JSON.stringify(out)).not.toContain("légende");
  });

  it("statuts : sent, delivered, read, failed (code d'erreur numérique, jamais son texte)", () => {
    const out = normalize(wrap({ statuses: [status({ status: "sent" }), status({ status: "read" }), status({ status: "failed", errors: [{ code: 131047, title: "Re-engagement message", message: "Texte de Meta" }] })] }));
    expect(out?.events.map((e) => (e.kind === "status" ? [e.status, e.errorCode] : null))).toEqual([["sent", null], ["read", null], ["failed", 131047]]);
    expect(JSON.stringify(out)).not.toContain("Texte de Meta");
  });

  it("éléments mal formés écartés et comptés (identifiant, numéro, statut inconnu) ; les bons passent", () => {
    const out = normalize(wrap({ messages: [message(), message({ id: "pas valide !" }), message({ from: "abc" }), 42], statuses: [status({ status: "deleted" }), status({ id: 7 })] }));
    expect(out?.events).toHaveLength(1);
    expect(out?.skipped).toBe(5);
  });

  it("notifications sans messages ni statuts (état du compte, modèles) : acceptées, aucun événement", () => {
    expect(normalize(wrap({ event: "VERIFIED_ACCOUNT" }, "account_update"))?.events).toEqual([]);
    expect(normalize(wrap({ message_template_status_update: {} }, "message_template_status_update"))?.events).toEqual([]);
  });

  it("horodatage hors bornes (12 chiffres, année 33658) : ignoré (null), jamais une date que la base refuserait", () => {
    const out = normalize(wrap({ messages: [message({ timestamp: "999999999999" })] }));
    expect((out?.events[0] as { at: string | null }).at).toBeNull();
  });

  it("réactions et événements système : écartés (aucun message, le fil n'est pas rouvert) ; boutons et réponses interactives gardent leur libellé", () => {
    const out = normalize(wrap({ messages: [
      message({ id: "wamid.R", type: "reaction", text: undefined, reaction: { emoji: "👍" } }),
      message({ id: "wamid.S", type: "system", text: undefined }),
      message({ id: "wamid.B", type: "button", text: undefined, button: { text: "STOP", payload: "x" } }),
      message({ id: "wamid.I", type: "interactive", text: undefined, interactive: { type: "button_reply", button_reply: { id: "1", title: "Je suis intéressé" } } }),
      message({ id: "wamid.L", type: "interactive", text: undefined, interactive: { type: "list_reply", list_reply: { id: "2", title: "Option B" } } }),
    ] }));
    expect(out?.events.map((e) => (e.kind === "message" ? [e.id, e.type, e.text] : null))).toEqual([["wamid.B", "button", "STOP"], ["wamid.I", "interactive", "Je suis intéressé"], ["wamid.L", "interactive", "Option B"]]);
    expect(out?.skipped).toBe(2);
  });

  it("éléments au-delà de 1000 par liste : comptés dans skipped", () => {
    const out = normalize(wrap({ messages: Array.from({ length: 1005 }, (_, i) => message({ id: `wamid.${i}` })) }));
    expect(out?.events).toHaveLength(1000);
    expect(out?.skipped).toBe(5);
    const few = normalize(wrap({ messages: Array.from({ length: 3 }, (_, i) => message({ id: `wamid.${i}` })) }));
    expect(few?.skipped).toBe(0);
  });

  it("texte nettoyé : NUL retirés, surrogate isolé remplacé, coupé à 4096 points de code", () => {
    const out = normalize(wrap({ messages: [message({ text: { body: `a\u0000b\uD800c${"é".repeat(5000)}` } })] }));
    const text = (out?.events[0] as { text: string }).text;
    expect(text.startsWith("ab�c")).toBe(true);
    expect(Array.from(text)).toHaveLength(WHATSAPP_TEXT_MAX);
    expect(text).not.toContain("\u0000");
  });

  it("structure invalide : null (jamais d'exception) ; numéro invalide présent : null ; trop d'événements : null", () => {
    for (const bad of [null, "x", 1, [], {}, { object: "page" }, { object: "whatsapp_business_account", entry: "x" }, { object: "whatsapp_business_account", entry: [{ changes: "x" }] }, wrap({ messages: [message()] }, "messages") && { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "abc" } } }] }] }]) {
      expect(normalize(bad)).toBeNull();
    }
    const many = wrap({ messages: Array.from({ length: 700 }, (_, i) => message({ id: `wamid.${i}` })), statuses: Array.from({ length: 700 }, (_, i) => status({ id: `wamid.s${i}` })) });
    expect(normalize(many)).toBeNull();
  });

  it("plusieurs numéros : conservés pour que l'adaptateur refuse la requête", () => {
    const entry = wrap({ messages: [message()] }).entry[0];
    const other = wrap({ messages: [message({ id: "wamid.2" })] }).entry[0] as { changes: Array<{ value: { metadata: { phone_number_id: string } } }> };
    other.changes[0]!.value.metadata.phone_number_id = "999999999999";
    expect(normalize({ object: "whatsapp_business_account", entry: [entry, other] })?.phoneNumberIds).toEqual([PHONE, "999999999999"]);
  });
});

describe("relecture de la forme conservée", () => {
  it("aller-retour : ce que la normalisation écrit se relit identique", () => {
    const stored = normalize(wrap({ messages: [message()], statuses: [status()] }));
    expect(read(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });
  it("forme altérée : null (deux numéros, événement sans identifiant, genre inconnu, numéro non E.164)", () => {
    const base = normalize(wrap({ messages: [message()] })) as ReturnType<typeof normalize> & object;
    for (const bad of [
      { ...base, phoneNumberIds: [PHONE, "999999999999"] },
      { ...base, phoneNumberIds: [] },
      { ...base, events: [{ kind: "message", from: "+212600000000", type: "text", text: "x", at: null }] },
      { ...base, events: [{ kind: "autre", id: "wamid.1" }] },
      { ...base, events: [{ kind: "message", id: "wamid.1", from: "212600000000", type: "text", text: "x", at: null }] },
      { ...base, events: [{ kind: "status", id: "wamid.1", status: "deleted", at: null, errorCode: null }] },
      { ...base, skipped: "0" },
      null, "x", {},
    ]) {
      expect(read(bad)).toBeNull();
    }
  });
});
