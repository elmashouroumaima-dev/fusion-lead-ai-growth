import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index";

describe("@fusion-leap/domain (smoke)", () => {
  it("exporte son nom de package", () => {
    expect(PACKAGE_NAME).toBe("@fusion-leap/domain");
  });
});
