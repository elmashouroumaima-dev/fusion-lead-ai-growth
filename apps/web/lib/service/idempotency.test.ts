import { describe, expect, it, vi } from "vitest";
import type { ServerSupabase } from "../tenant/identity";
import { ServiceError } from "./errors";
import {
  canonicalJson,
  canonicalRequestHash,
  decideIdempotency,
  errorForDecision,
  idempotencyAbandon,
  idempotencyBegin,
  idempotencyComplete,
} from "./idempotency";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KEY = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ATTEMPT = "11111111-2222-4333-8444-555555555555";
const base = { method: "POST", path: "/api/orgs", body: { name: "Acme", locale: "fr" } };

describe("canonicalJson", () => {
  it("trie les clés, sans espace, ordre des tableaux conservé", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: null } })).toBe('{"a":{"c":null,"d":[3,1,2]},"b":1}');
  });
  it("ignore undefined dans les objets, le convertit en null dans un tableau", () => {
    expect(canonicalJson({ a: undefined, b: [undefined, 1] })).toBe('{"b":[null,1]}');
  });
  it("hache les chaînes telles quelles (aucune normalisation Unicode)", () => {
    // « é » précomposé (U+00E9) contre « e » + accent combinant (U+0065 U+0301).
    expect(canonicalJson("é")).not.toBe(canonicalJson("é"));
  });
  it.each([[Number.NaN], [Infinity], [10n], [() => 1], [new Date()], [Symbol("x")]])("refuse la valeur non JSON %s", (value) => {
    expect(() => canonicalJson({ v: value })).toThrow(TypeError);
  });
});

describe("canonicalRequestHash", () => {
  it("SHA-256 hexadécimal en minuscules (64)", () => {
    expect(canonicalRequestHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("indépendant de l'ordre des clés et de la casse de la méthode", () => {
    expect(canonicalRequestHash({ method: "post", path: "/api/orgs", body: { locale: "fr", name: "Acme" } })).toBe(canonicalRequestHash(base));
  });
  it.each([
    ["autre corps", { ...base, body: { name: "Autre", locale: "fr" } }],
    ["autre chemin", { ...base, path: "/api/other" }],
    ["autre méthode", { ...base, method: "PUT" }],
  ])("%s -> autre empreinte", (_l, other) => {
    expect(canonicalRequestHash(other)).not.toBe(canonicalRequestHash(base));
  });
  it("l'ordre d'un tableau compte", () => {
    expect(canonicalRequestHash({ ...base, body: { a: [1, 2] } })).not.toBe(canonicalRequestHash({ ...base, body: { a: [2, 1] } }));
  });
  it("un corps absent et un corps null sont équivalents", () => {
    expect(canonicalRequestHash({ ...base, body: undefined })).toBe(canonicalRequestHash({ ...base, body: null }));
  });
});

describe("decideIdempotency (fonction pure)", () => {
  it("interprète les quatre états", () => {
    expect(decideIdempotency({ state: "new", attempt_id: ATTEMPT })).toEqual({ state: "new", attemptId: ATTEMPT });
    expect(decideIdempotency({ state: "conflict" })).toEqual({ state: "conflict" });
    expect(decideIdempotency({ state: "in_progress" })).toEqual({ state: "in_progress" });
    expect(decideIdempotency({ state: "replay", status_code: 201, response: { body: 1 } })).toEqual({
      state: "replay",
      statusCode: 201,
      response: { body: 1 },
    });
  });
  it.each([
    [null],
    ["new"],
    [[]],
    [{}],
    [{ state: "unknown" }],
    [{ state: "replay" }],
    [{ state: "replay", status_code: 99 }],
    [{ state: "replay", status_code: 200.5 }],
    [{ state: "replay", status_code: "200" }],
    [{ state: "new" }],
    [{ state: "new", attempt_id: null }],
    [{ state: "new", attempt_id: "pas-un-uuid" }],
    [{ state: "new", attempt_id: 42 }],
  ])("forme inattendue %j -> internal_error", (raw) => {
    expect(() => decideIdempotency(raw)).toThrow(ServiceError);
  });
  it("seuls conflict et in_progress bloquent l'exécution", () => {
    expect(errorForDecision({ state: "new", attemptId: ATTEMPT })).toBeNull();
    expect(errorForDecision({ state: "replay", statusCode: 200, response: {} })).toBeNull();
    expect(errorForDecision({ state: "conflict" })?.code).toBe("idempotency_conflict");
    expect(errorForDecision({ state: "in_progress" })?.code).toBe("idempotency_in_progress");
  });
});

function client(result: { data?: unknown; error?: { code?: string; message?: string } | null } | Error) {
  const rpc = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return { data: null, error: null, ...result };
  });
  return { supabase: { rpc } as unknown as ServerSupabase, rpc };
}

describe("appels RPC (client de l'utilisateur)", () => {
  const ref = { organizationId: ORG, key: KEY, requestHash: "a".repeat(64) };

  it("idempotency_begin : paramètres du contrat, aucune identité fournie", async () => {
    const { supabase, rpc } = client({ data: { state: "new", attempt_id: ATTEMPT } });
    await expect(idempotencyBegin(supabase, ref)).resolves.toEqual({ state: "new", attemptId: ATTEMPT });
    expect(rpc).toHaveBeenCalledWith("idempotency_begin", { p_org: ORG, p_key: KEY, p_request_hash: "a".repeat(64) });
  });
  it.each([
    [{ code: "42501" }, "forbidden"],
    [{ code: "28000" }, "unauthenticated"],
    [{ code: "22023", message: "validation_failed" }, "validation_failed"],
    [{ code: "P0001", message: "quota_exceeded" }, "quota_exceeded"],
    [{ code: "XX000", message: "texte brut secret" }, "internal_error"],
  ] as const)("erreur SQL %j -> %s", async (error, code) => {
    const { supabase } = client({ error });
    await expect(idempotencyBegin(supabase, ref)).rejects.toMatchObject({ code });
  });
  it("exception réseau -> internal_error", async () => {
    const { supabase } = client(new Error("ECONNRESET"));
    await expect(idempotencyBegin(supabase, ref)).rejects.toMatchObject({ code: "internal_error" });
  });
  it("idempotency_complete : statut et réponse transmis", async () => {
    const { supabase, rpc } = client({});
    await idempotencyComplete(supabase, { organizationId: ORG, key: KEY, attemptId: ATTEMPT, statusCode: 201, response: { body: { ok: true } } });
    expect(rpc).toHaveBeenCalledWith("idempotency_complete", {
      p_org: ORG,
      p_key: KEY,
      p_attempt_id: ATTEMPT,
      p_status_code: 201,
      p_response: { body: { ok: true } },
    });
  });
  it("idempotency_abandon : best effort, n'échoue jamais", async () => {
    const { supabase, rpc } = client(new Error("down"));
    await expect(idempotencyAbandon(supabase, { organizationId: ORG, key: KEY, attemptId: ATTEMPT })).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith("idempotency_abandon", { p_org: ORG, p_key: KEY, p_attempt_id: ATTEMPT });
  });
  it("idempotency_complete avec une tentative périmée (invalid_state) -> erreur interne, jamais un succès silencieux", async () => {
    const { supabase } = client({ error: { code: "P0001", message: "invalid_state" } });
    await expect(idempotencyComplete(supabase, { organizationId: ORG, key: KEY, attemptId: ATTEMPT, statusCode: 200, response: {} })).rejects.toMatchObject({
      code: "internal_error",
    });
  });
});
