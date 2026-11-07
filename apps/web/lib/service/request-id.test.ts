import { describe, expect, it } from "vitest";
import { REQUEST_ID_HEADER, resolveRequestIds } from "./request-id";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("resolveRequestIds", () => {
  it("génère toujours un uuid côté serveur, sans en-tête", () => {
    const ids = resolveRequestIds(new Headers());
    expect(ids.requestId).toMatch(UUID_RE);
    expect(ids.clientRequestId).toBeUndefined();
  });
  it("un x-request-id sûr n'est JAMAIS repris comme request_id : il devient client_request_id", () => {
    const ids = resolveRequestIds(new Headers({ [REQUEST_ID_HEADER]: "req-12345678" }));
    expect(ids.requestId).toMatch(UUID_RE);
    expect(ids.requestId).not.toBe("req-12345678");
    expect(ids.clientRequestId).toBe("req-12345678");
  });
  it("même un uuid fourni par le client est remplacé par un uuid frais", () => {
    const supplied = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const ids = resolveRequestIds(new Headers({ [REQUEST_ID_HEADER]: supplied }));
    expect(ids.requestId).not.toBe(supplied);
    expect(ids.clientRequestId).toBe(supplied);
  });
  it.each(["short", "has space in it", "x".repeat(129), "a\r\nb-injected-header"])("%j est ignoré (ni request_id ni client_request_id)", (value) => {
    const ids = resolveRequestIds({ get: () => value });
    expect(ids.requestId).toMatch(UUID_RE);
    expect(ids.clientRequestId).toBeUndefined();
  });
  it("deux appels donnent deux request_id distincts", () => {
    const headers = new Headers({ [REQUEST_ID_HEADER]: "req-12345678" });
    expect(resolveRequestIds(headers).requestId).not.toBe(resolveRequestIds(headers).requestId);
  });
});
