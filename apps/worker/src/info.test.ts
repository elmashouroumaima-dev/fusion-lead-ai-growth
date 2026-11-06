import { describe, expect, it } from "vitest";
import { WORKER_NAME } from "./info";

describe("@fusion-leap/worker (smoke)", () => {
  it("expose son nom", () => {
    expect(WORKER_NAME).toBe("fusion-leap-worker");
  });
});
