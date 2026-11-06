import { describe, expect, it } from "vitest";
import { APP_NAME } from "./app-info";

describe("@fusion-leap/web (smoke)", () => {
  it("expose le nom de l'application", () => {
    expect(APP_NAME).toBe("Fusion Leap AI Growth");
  });
});
