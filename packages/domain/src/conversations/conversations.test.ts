import { describe, expect, it } from "vitest";
import {
  assignConversationSchema,
  conversationRowSchema,
  isStateAllowed,
  listConversationsSchema,
  messageRowSchema,
  setConversationStateSchema,
} from "./schemas";

const ID = "11111111-1111-4111-8111-111111111111";
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("isStateAllowed", () => {
  it("la file de tri n'existe que sans responsable ; « open » exige un responsable ; fermé et en attente : toujours", () => {
    expect(isStateAllowed("to_triage", false)).toBe(true);
    expect(isStateAllowed("to_triage", true)).toBe(false);
    expect(isStateAllowed("open", true)).toBe(true);
    expect(isStateAllowed("open", false)).toBe(false);
    for (const state of ["pending", "closed"] as const) {
      expect(isStateAllowed(state, true)).toBe(true);
      expect(isStateAllowed(state, false)).toBe(true);
    }
  });
});

describe("schémas d'entrée", () => {
  it("assigner : identifiant valide, responsable ou null ; aucun champ de plus, jamais d'organization_id", () => {
    expect(assignConversationSchema.safeParse({ conversation_id: ID, assignee_id: ID }).success).toBe(true);
    expect(assignConversationSchema.safeParse({ conversation_id: ID, assignee_id: null }).success).toBe(true);
    expect(assignConversationSchema.safeParse({ conversation_id: ID }).success).toBe(false);
    expect(assignConversationSchema.safeParse({ conversation_id: "x", assignee_id: null }).success).toBe(false);
    expect(assignConversationSchema.safeParse({ conversation_id: ID, assignee_id: null, organization_id: ORG }).success).toBe(false);
  });

  it("état : valeur de la liste fermée seulement", () => {
    expect(setConversationStateSchema.safeParse({ conversation_id: ID, state: "closed" }).success).toBe(true);
    expect(setConversationStateSchema.safeParse({ conversation_id: ID, state: "archived" }).success).toBe(false);
    expect(setConversationStateSchema.safeParse({ conversation_id: ID, state: "closed", force: true }).success).toBe(false);
  });

  it("liste : page 1 par défaut, bornée ; filtres stricts", () => {
    expect(listConversationsSchema.parse({}).page).toBe(1);
    expect(listConversationsSchema.safeParse({ page: 0 }).success).toBe(false);
    expect(listConversationsSchema.safeParse({ page: 10_001 }).success).toBe(false);
    expect(listConversationsSchema.safeParse({ state: "open", unassigned: true }).success).toBe(true);
    expect(listConversationsSchema.safeParse({ state: "inconnu" }).success).toBe(false);
  });
});

describe("lignes lisibles", () => {
  it("une conversation ne porte aucun champ de verrou ; un message porte son corps mais pas l'identifiant du fournisseur", () => {
    const conversation = conversationRowSchema.parse({
      id: ID, organization_id: ORG, contact_id: ID, channel_id: ID, assignee_id: null, state: "to_triage", handled_by: "human",
      last_message_at: null, created_at: "2026-11-10T00:00:00Z", updated_at: "2026-11-10T00:00:00Z", lock_owner: ID,
    });
    expect(conversation).not.toHaveProperty("lock_owner");
    const message = messageRowSchema.parse({
      id: ID, organization_id: ORG, conversation_id: ID, channel_id: ID, direction: "inbound", body: "Bonjour", status: "received",
      sent_at: null, received_at: "2026-11-10T00:00:00Z", error_code: null, created_at: "2026-11-10T00:00:00Z", provider_message_id: "wamid.1",
    });
    expect(message).not.toHaveProperty("provider_message_id");
    expect(message.body).toBe("Bonjour");
  });

  it("statut ou état inconnu : ligne refusée (jamais une ligne partielle)", () => {
    expect(messageRowSchema.safeParse({ id: ID, organization_id: ORG, conversation_id: ID, channel_id: ID, direction: "inbound", body: "x", status: "inconnu", sent_at: null, received_at: null, error_code: null, created_at: "t" }).success).toBe(false);
  });
});
