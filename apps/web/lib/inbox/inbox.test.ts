import { describe, expect, it, vi } from "vitest";
import { NO_ASSIGNEE, assignConversationFormSchema, setConversationStateFormSchema, INBOX_ASSIGN_FIELDS, INBOX_STATE_FIELDS } from "./action-schemas";
import { getInboxConversation, inboxHref, parseInboxParams, searchInbox } from "./queries";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const MEMBER = "66666666-6666-4666-8666-666666666666";
const ORG = "22222222-2222-4222-8222-222222222222";

const row = (over: Record<string, unknown> = {}) => ({
  id: CONVERSATION, contact_id: MEMBER, channel_id: MEMBER, assignee_id: null, state: "to_triage", last_message_at: "2026-11-10T10:00:00+00:00",
  contact_name: "Nadia", contact_email: "n@x.test", contact_phone: null, channel_type: "email", last_direction: "inbound", last_status: "received",
  last_preview: "Bonjour", last_truncated: false, total_count: 1, ...over,
});

describe("parseInboxParams", () => {
  it("lit l'état, le canal, le responsable, la recherche et la page ; toute valeur inconnue est ignorée", () => {
    const ok = parseInboxParams({ state: "open", channel: "whatsapp", assignee: "me", q: "  nadia  ", page: "3" });
    expect(ok).toEqual({ filters: { state: "open", channel: "whatsapp", assignee: "me", query: "nadia" }, page: 3 });
    const bad = parseInboxParams({ state: "bidon", channel: "sms", assignee: "x", q: "   ", page: "abc" });
    expect(bad).toEqual({ filters: { state: null, channel: null, assignee: "all", query: null }, page: 1 });
    expect(parseInboxParams({ page: "0" }).page).toBe(1);
    expect(parseInboxParams({ page: "999999" }).page).toBe(1);
    expect(parseInboxParams({ q: "x".repeat(300) }).filters.query).toHaveLength(100);
    expect(parseInboxParams({ state: ["closed", "open"] }).filters.state).toBe("closed");
  });
});

describe("inboxHref", () => {
  it("reconstruit l'adresse avec les seuls filtres posés ; la première page n'a pas de paramètre de page", () => {
    expect(inboxHref({ state: null, channel: null, assignee: "all", query: null })).toBe("/inbox");
    expect(inboxHref({ state: "open", channel: "email", assignee: "none", query: "a b" }, 2)).toBe("/inbox?state=open&channel=email&assignee=none&q=a+b&page=2");
  });
});

describe("searchInbox", () => {
  const filters = { state: null, channel: null, assignee: "me" as const, query: "nadia" };

  it("appelle search_conversations avec l'entreprise du contexte, le responsable « moi » et la pagination", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [row({ total_count: 40 })], error: null });
    const result = await searchInbox({ rpc } as never, ORG, MEMBER, filters, 2);
    expect(rpc).toHaveBeenCalledWith("search_conversations", {
      p_org: ORG, p_state: null, p_channel: null, p_assignee: MEMBER, p_unassigned: false, p_query: "nadia", p_limit: 25, p_offset: 25,
    });
    expect(result.total).toBe(40);
    expect(result.pageCount).toBe(2);
    expect(result.rows[0]?.contact_name).toBe("Nadia");
  });

  it("« non assignées » devient p_unassigned ; une page au-delà du total relit le total", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: [], error: null }).mockResolvedValueOnce({ data: [row({ total_count: 3 })], error: null });
    const result = await searchInbox({ rpc } as never, ORG, MEMBER, { ...filters, assignee: "none" }, 9);
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_assignee: null, p_unassigned: true, p_offset: 200 });
    expect(result.total).toBe(3);
    expect(result.rows).toEqual([]);
  });

  it("une erreur de la base ou une ligne illisible lève une erreur générique (jamais de détail)", async () => {
    await expect(searchInbox({ rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "secret" } }) } as never, ORG, MEMBER, filters, 1)).rejects.toThrow("inbox_search_failed");
    await expect(searchInbox({ rpc: vi.fn().mockResolvedValue({ data: [{ id: "x" }], error: null }) } as never, ORG, MEMBER, filters, 1)).rejects.toThrow("rows_unreadable");
  });
});

describe("getInboxConversation", () => {
  it("demande une seule conversation ; aucune ligne = null (inconnue, autre entreprise ou hors droits : indiscernables)", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: [row()], error: null }).mockResolvedValueOnce({ data: [], error: null });
    expect((await getInboxConversation({ rpc } as never, ORG, CONVERSATION))?.id).toBe(CONVERSATION);
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_org: ORG, p_conversation: CONVERSATION, p_limit: 1 });
    expect(await getInboxConversation({ rpc } as never, ORG, CONVERSATION)).toBeNull();
  });
});

describe("schémas des actions", () => {
  it("assigner : un membre, ou « aucun responsable » (valeur du menu ou vide) = null ; identifiant invalide refusé", () => {
    const member = assignConversationFormSchema.safeParse({ conversation_id: CONVERSATION, assignee_id: MEMBER });
    expect(member.success && member.data.assignee_id).toBe(MEMBER);
    for (const value of [NO_ASSIGNEE, "", undefined]) {
      const none = assignConversationFormSchema.safeParse({ conversation_id: CONVERSATION, assignee_id: value });
      expect(none.success && none.data.assignee_id).toBeNull();
    }
    expect(assignConversationFormSchema.safeParse({ conversation_id: CONVERSATION, assignee_id: "x" }).success).toBe(false);
    expect(assignConversationFormSchema.safeParse({ conversation_id: "x", assignee_id: MEMBER }).success).toBe(false);
  });

  it("état : seuls les quatre états connus sont acceptés", () => {
    for (const state of ["open", "pending", "closed", "to_triage"]) expect(setConversationStateFormSchema.safeParse({ conversation_id: CONVERSATION, state }).success).toBe(true);
    expect(setConversationStateFormSchema.safeParse({ conversation_id: CONVERSATION, state: "archived" }).success).toBe(false);
  });

  it("les listes de champs ne contiennent PAS l'entreprise : elle vient du contexte vérifié", () => {
    expect(INBOX_ASSIGN_FIELDS as readonly string[]).not.toContain("organization_id");
    expect(INBOX_STATE_FIELDS as readonly string[]).not.toContain("organization_id");
  });
});
