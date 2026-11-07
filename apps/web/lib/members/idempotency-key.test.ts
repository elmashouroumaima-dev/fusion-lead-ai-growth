import { describe, expect, it } from "vitest";
import { shouldRenewIdempotencyKey } from "./idempotency-key";
import type { MembersActionErrorCode } from "./types";

describe("shouldRenewIdempotencyKey (formulaire d'invitation)", () => {
  it("succès -> nouvelle clé", () => {
    expect(shouldRenewIdempotencyKey({ status: "success" })).toBe(true);
  });
  it("idempotency_conflict -> nouvelle clé", () => {
    expect(shouldRenewIdempotencyKey({ status: "error", code: "idempotency_conflict" })).toBe(true);
  });
  it("idempotency_in_progress -> la MÊME clé (la première demande peut encore aboutir)", () => {
    expect(shouldRenewIdempotencyKey({ status: "error", code: "idempotency_in_progress" })).toBe(false);
  });
  it.each<MembersActionErrorCode>([
    "duplicate_request",
    "invalid_input",
    "forbidden",
    "already_member",
    "invitation_invalid",
    "last_owner",
    "rate_limited",
    "service_unavailable",
    "generic",
  ])("erreur %s -> clé conservée", (code) => {
    expect(shouldRenewIdempotencyKey({ status: "error", code })).toBe(false);
  });
  it("état initial -> clé conservée", () => {
    expect(shouldRenewIdempotencyKey({ status: "idle" })).toBe(false);
  });
});
