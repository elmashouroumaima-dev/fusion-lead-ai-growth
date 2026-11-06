import { APP_ROLES } from "@fusion-leap/domain";
import { describe, expect, it } from "vitest";
import ar from "./ar.json";
import en from "./en.json";
import fr from "./fr.json";

describe("messages Org.*", () => {
  it.each([
    ["ar", ar.Org],
    ["en", en.Org],
    ["fr", fr.Org],
  ] as const)("%s : un libellé pour chaque rôle et chaque code d'erreur d'action", (_l, org) => {
    for (const role of APP_ROLES) expect(org.roles[role], role).toBeTruthy();
    for (const code of ["invalid_input", "forbidden", "idempotency_conflict", "rate_limited", "generic"] as const) {
      expect(org.errors[code], code).toBeTruthy();
    }
  });
});
