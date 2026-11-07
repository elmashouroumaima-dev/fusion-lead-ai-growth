import { describe, expect, it } from "vitest";
import { parseInitialError } from "./initial-error";

describe("parseInitialError", () => {
  it("accepte exactement link_invalid", () => {
    expect(parseInitialError("link_invalid")).toBe("link_invalid");
  });

  it.each([undefined, "", "LINK_INVALID", "generic", "link_invalid ", "<script>", ["link_invalid"], 42, null])(
    "rejette %j",
    (value) => {
      expect(parseInitialError(value)).toBeUndefined();
    },
  );
});
