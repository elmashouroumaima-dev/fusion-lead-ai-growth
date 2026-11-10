import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSupabase } from "../tenant/identity";
import { assignConversation, getConversation, listConversations, listMessages, setConversationState } from "./service";

const ORG = "bb000000-0000-4000-8000-00000000000a";
const CONV = "7a000000-0000-4000-8000-000000000001";
const USER = "7b000000-0000-4000-8000-000000000001";
const NOW = "2026-11-10T10:00:00+00:00";

function fakeClient() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const state = {
    data: [] as unknown,
    single: null as unknown,
    dbError: null as unknown,
    rpc: ((): { data: unknown; error: unknown } => ({ data: null, error: null })) as (name: string) => { data: unknown; error: unknown },
  };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ op: `rpc:${name}`, args: [args] });
    return state.rpc(name);
  });
  const from = (table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "is", "order", "range"]) {
      query[method] = (...args: unknown[]) => {
        calls.push({ op: `${table}.${method}`, args });
        return query;
      };
    }
    query.maybeSingle = async () => ({ data: state.single, error: state.dbError });
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: state.data, error: state.dbError }).then(resolve);
    return query;
  };
  return { client: { rpc, from } as unknown as ServerSupabase, state, calls };
}

let c: ReturnType<typeof fakeClient>;
beforeEach(() => {
  c = fakeClient();
});

const conversation = { id: CONV, organization_id: ORG, contact_id: CONV, channel_id: CONV, assignee_id: null, state: "to_triage", handled_by: "human", last_message_at: null, created_at: NOW, updated_at: NOW };
const message = { id: CONV, organization_id: ORG, conversation_id: CONV, channel_id: CONV, direction: "inbound", body: "Bonjour", status: "received", sent_at: null, received_at: NOW, error_code: null, created_at: NOW };

describe("listConversations", () => {
  it("entreprise du contexte, colonnes explicites sans verrou, tri par activité, 25 par page, filtres appliqués", async () => {
    c.state.data = [conversation];
    const page = await listConversations(c.client, ORG, { page: 3, state: "open", assignee_id: USER, unassigned: true });
    expect(page.rows).toHaveLength(1);
    expect(page.pageSize).toBe(25);
    const select = c.calls.find((call) => call.op === "conversations.select");
    expect(String(select?.args[0])).not.toContain("lock_");
    expect(String(select?.args[0])).not.toBe("*");
    expect(c.calls).toContainEqual({ op: "conversations.eq", args: ["organization_id", ORG] });
    expect(c.calls).toContainEqual({ op: "conversations.eq", args: ["state", "open"] });
    expect(c.calls).toContainEqual({ op: "conversations.eq", args: ["assignee_id", USER] });
    expect(c.calls).toContainEqual({ op: "conversations.is", args: ["assignee_id", null] });
    expect(c.calls).toContainEqual({ op: "conversations.range", args: [50, 74] });
  });

  it("ligne illisible ou erreur de la base : erreur, jamais une ligne partielle", async () => {
    c.state.data = [{ ...conversation, state: "inconnu" }];
    await expect(listConversations(c.client, ORG, { page: 1 })).rejects.toThrow("rows_unreadable");
    c.state.data = [];
    c.state.dbError = { code: "42501" };
    await expect(listConversations(c.client, ORG, { page: 1 })).rejects.toThrow("conversations_lookup_failed");
  });
});

describe("getConversation et listMessages", () => {
  it("conversation visible rendue ; absente, interdite ou d'une autre entreprise : null (indiscernables)", async () => {
    c.state.single = conversation;
    expect((await getConversation(c.client, ORG, CONV))?.id).toBe(CONV);
    c.state.single = null;
    expect(await getConversation(c.client, ORG, CONV)).toBeNull();
    expect(c.calls).toContainEqual({ op: "conversations.eq", args: ["organization_id", ORG] });
  });

  it("messages : 50 par page, du plus récent au plus ancien, corps lu seulement ici ; page vide si la RLS refuse", async () => {
    c.state.data = [message];
    const rows = await listMessages(c.client, ORG, CONV, 2);
    expect(rows).toEqual([message]);
    expect(c.calls).toContainEqual({ op: "messages.range", args: [50, 99] });
    expect(c.calls).toContainEqual({ op: "messages.eq", args: ["conversation_id", CONV] });
    expect(String(c.calls.find((call) => call.op === "messages.select")?.args[0])).not.toContain("provider_message_id");
    c.state.data = [];
    expect(await listMessages(c.client, ORG, CONV)).toEqual([]);
  });
});

describe("assignConversation et setConversationState", () => {
  it("appellent les fonctions avec l'entreprise du contexte et rien d'autre", async () => {
    expect(await assignConversation(c.client, ORG, { conversation_id: CONV, assignee_id: USER })).toEqual({ ok: true, value: true });
    expect(await setConversationState(c.client, ORG, { conversation_id: CONV, state: "closed" })).toEqual({ ok: true, value: true });
    expect(c.calls[0]).toEqual({ op: "rpc:assign_conversation", args: [{ p_org: ORG, p_id: CONV, p_assignee: USER }] });
    expect(c.calls[1]).toEqual({ op: "rpc:set_conversation_state", args: [{ p_org: ORG, p_id: CONV, p_state: "closed" }] });
  });

  it("erreurs de la base : rôle = forbidden ; introuvable = not_found ; responsable non assignable ou état incohérent = validation_failed", async () => {
    const cases: Array<[unknown, string]> = [
      [{ code: "42501" }, "forbidden"],
      [{ code: "PT404" }, "not_found"],
      [{ code: "P0001", message: "assignee_invalid" }, "validation_failed"],
      [{ code: "22023" }, "validation_failed"],
    ];
    for (const [error, code] of cases) {
      c.state.rpc = () => ({ data: null, error });
      expect(await assignConversation(c.client, ORG, { conversation_id: CONV, assignee_id: USER })).toEqual({ ok: false, code });
      expect(await setConversationState(c.client, ORG, { conversation_id: CONV, state: "open" })).toEqual({ ok: false, code });
    }
  });
});
