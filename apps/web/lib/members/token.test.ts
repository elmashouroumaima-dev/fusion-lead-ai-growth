import { createHash } from "node:crypto";
import { invitationTokenHashSchema, invitationTokenSchema } from "@fusion-leap/domain";
import { describe, expect, it } from "vitest";
import { mapMembersDbError } from "./map-error";
import { generateInvitationToken, hashInvitationToken } from "./token";

describe("generateInvitationToken", () => {
  it("jeton de 43 caractères base64url, hash sha256 hex de 64 caractères", () => {
    const { token, tokenHash } = generateInvitationToken();
    expect(invitationTokenSchema.safeParse(token).success).toBe(true);
    expect(invitationTokenHashSchema.safeParse(tokenHash).success).toBe(true);
    expect(tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(tokenHash).toBe(hashInvitationToken(token));
    expect(tokenHash).not.toContain(token);
  });

  it("deux jetons ne se répètent pas (1000 tirages)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateInvitationToken().token);
    expect(seen.size).toBe(1000);
  });

  it("vecteur connu : sha256 de 'abc'", () => {
    expect(hashInvitationToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("mapMembersDbError", () => {
  it.each([
    [{ code: "42501", message: "forbidden" }, "forbidden"],
    [{ code: "28000", message: "unauthenticated" }, "forbidden"],
    [{ code: "22023", message: "validation_failed" }, "invalid_input"],
    [{ code: "23514", message: "cannot remove" }, "last_owner"],
    [{ code: "P0001", message: "already_member" }, "already_member"],
    [{ code: "P0001", message: "invitation_invalid" }, "invitation_invalid"],
    [{ code: "P0001", message: "invalid_target" }, "invalid_input"],
    [{ code: "P0001", message: "forbidden" }, "forbidden"],
    [{ code: "P0001", message: "autre" }, "generic"],
    [{ code: "PGRST301", message: "JWT" }, "generic"],
    [null, "generic"],
    [undefined, "generic"],
    [{}, "generic"],
  ] as const)("%j -> %s", (error, expected) => {
    expect(mapMembersDbError(error)).toBe(expected);
  });
});
