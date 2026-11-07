import { describe, expect, it } from "vitest";
import { mapAuthError } from "./map-error";

describe("mapAuthError", () => {
  it("mappe les codes connus", () => {
    expect(mapAuthError({ code: "invalid_credentials" })).toBe("invalid_credentials");
    expect(mapAuthError({ code: "email_not_confirmed" })).toBe("email_not_confirmed");
    expect(mapAuthError({ code: "weak_password" })).toBe("weak_password");
    expect(mapAuthError({ code: "over_email_send_rate_limit" })).toBe("rate_limited");
    expect(mapAuthError({ status: 429 })).toBe("rate_limited");
  });
  it("ne distingue pas un compte inconnu d'un mauvais mot de passe", () => {
    expect(mapAuthError({ code: "user_not_found" })).toBe("generic");
  });
  it("retombe sur generic", () => {
    expect(mapAuthError({})).toBe("generic");
  });
});
