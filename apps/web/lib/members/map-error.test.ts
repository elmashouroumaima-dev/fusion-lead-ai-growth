import { describe, expect, it } from "vitest";
import { mapMembersDbError } from "./map-error";

describe("mapMembersDbError", () => {
  it("limite du plan (J14) : quota_exceeded et subscription_inactive donnent quota_exceeded", () => {
    expect(mapMembersDbError({ code: "P0001", message: "quota_exceeded" })).toBe("quota_exceeded");
    expect(mapMembersDbError({ code: "P0001", message: "subscription_inactive" })).toBe("quota_exceeded");
  });

  it("codes existants inchangés", () => {
    expect(mapMembersDbError({ code: "42501", message: "forbidden" })).toBe("forbidden");
    expect(mapMembersDbError({ code: "28000", message: "unauthenticated" })).toBe("forbidden");
    expect(mapMembersDbError({ code: "22023", message: "validation_failed" })).toBe("invalid_input");
    expect(mapMembersDbError({ code: "23514", message: "x" })).toBe("last_owner");
    expect(mapMembersDbError({ code: "P0001", message: "already_member" })).toBe("already_member");
    expect(mapMembersDbError({ code: "P0001", message: "invitation_invalid" })).toBe("invitation_invalid");
  });

  it("le reste est générique, jamais le message brut", () => {
    expect(mapMembersDbError({ code: "XX000", message: "password=secret" })).toBe("generic");
    expect(mapMembersDbError(null)).toBe("generic");
    expect(mapMembersDbError(undefined)).toBe("generic");
  });
});
