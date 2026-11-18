import { describe, expect, it } from "vitest";
import { greetingName } from "./greeting-name";

describe("greetingName", () => {
  it("début de l'adresse de connexion, sans domaine ni étiquette « +… »", () => {
    expect(greetingName("sara.benali@exemple.test")).toBe("sara.benali");
    expect(greetingName("sara+crm@exemple.test")).toBe("sara");
  });
  it("adresse absente, vide ou inexploitable : null (salutation seule)", () => {
    for (const bad of [undefined, null, 42, "", "@exemple.test", "+x@exemple.test", "   @a.test"]) expect(greetingName(bad), String(bad)).toBeNull();
  });
  it("limité à 40 caractères", () => {
    expect(greetingName(`${"a".repeat(80)}@exemple.test`)).toHaveLength(40);
  });
});
