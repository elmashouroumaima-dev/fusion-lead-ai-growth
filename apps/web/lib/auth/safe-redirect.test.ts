import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-redirect";

const FB = "/ar/dashboard";

describe("safeNext", () => {
  it.each([
    "/en/dashboard",
    "/ar/dashboard?tab=1",
    "/ar/leads/42#x",
    "/",
    "/ar",
    "/ar/search?q=a%20b",
    "/ar/path/http://not-a-scheme-here",
    "/ar/x?redirect=https://other.example",
  ])("accepte le chemin interne %s", (v) => {
    expect(safeNext(v, FB)).toBe(v);
  });

  const hostile: Array<[string, string]> = [
    ["double slash", "//evil.com"],
    ["double slash + path", "//evil.com/ar/dashboard"],
    ["triple slash", "///evil.com"],
    ["slash backslash", String.raw`/\evil.com`],
    ["double backslash", String.raw`\\evil.com`],
    ["backslash first", String.raw`\evil.com`],
    ["https scheme", "https://evil.com"],
    ["http scheme", "http://evil.com"],
    ["single-slash scheme typo", "http:/evil.com"],
    ["javascript scheme", "javascript:alert(1)"],
    ["javascript mixed case", "JaVaScRiPt:alert(1)"],
    ["data scheme", "data:text/html,<script>alert(1)</script>"],
    ["encoded double slash", "/%2F/evil.com"],
    ["fully encoded double slash", "%2F%2Fevil.com"],
    ["encoded slash after slash", "/%2Fevil.com"],
    ["encoded backslash", "/%5Cevil.com"],
    ["encoded backslash lowercase", "/%5cevil.com"],
    ["double-encoded slash", "/%252Fevil.com"],
    ["double-encoded backslash", "/%255Cevil.com"],
    ["LF raw", "/ok\nSet-Cookie: x=1"],
    ["CR raw", "/ok\rX"],
    ["TAB raw", "/\t/evil.com"],
    ["NUL raw", "/ok\u0000"],
    ["encoded CRLF", "/ok%0d%0aSet-Cookie:x"],
    ["encoded tab", "/%09/evil.com"],
    ["encoded NUL", "/%00"],
    ["DEL char", "/ok\u007f"],
    ["malformed percent escape", "/%E0%A4%A"],
    ["very long", "/" + "a".repeat(3000)],
    ["empty", ""],
    ["relative without slash", "dashboard"],
    ["relative dot", "./dashboard"],
    ["relative parent", "../dashboard"],
    ["bare host", "evil.com"],
    ["leading space + slashes", " //evil.com"],
    ["query only", "?next=/x"],
    ["fragment only", "#x"],
  ];

  it("la liste hostile compte au moins 25 cas", () => {
    expect(hostile.length).toBeGreaterThanOrEqual(25);
  });

  it.each(hostile)("rejette : %s", (_label, v) => {
    expect(safeNext(v, FB)).toBe(FB);
  });

  it.each<[string, unknown]>([
    ["undefined", undefined],
    ["null", null],
    ["number", 42],
    ["object", {}],
    ["array", ["/ok"]],
    ["boolean", true],
  ])("rejette le non-string : %s", (_l, v) => {
    expect(safeNext(v, FB)).toBe(FB);
  });

  it("renvoie exactement le repli fourni", () => {
    expect(safeNext("//evil.com", "/en/dashboard")).toBe("/en/dashboard");
  });
});
