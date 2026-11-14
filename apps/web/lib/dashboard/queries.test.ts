import { describe, expect, it } from "vitest";
import { dayPart, getDashboardCounts } from "./queries";

describe("dayPart", () => {
  const at = (iso: string) => new Date(iso);
  it("uses the organization time zone, not UTC", () => {
    // 23:30 UTC = 00:30 le lendemain à Casablanca (UTC+1) : « evening » dans les deux cas ; 10:00 UTC = 11:00 local.
    expect(dayPart(at("2026-11-13T10:00:00Z"), "Africa/Casablanca")).toBe("morning");
    expect(dayPart(at("2026-11-13T11:30:00Z"), "Africa/Casablanca")).toBe("afternoon");
    expect(dayPart(at("2026-11-13T04:30:00Z"), "Asia/Tokyo")).toBe("afternoon");
    expect(dayPart(at("2026-11-13T19:00:00Z"), "UTC")).toBe("evening");
  });
  it("falls back to UTC on an unknown time zone", () => {
    expect(dayPart(at("2026-11-13T08:00:00Z"), "Not/AZone")).toBe("morning");
  });
});

describe("getDashboardCounts", () => {
  it("does not query tables the role cannot read and hides errors as null", async () => {
    const queried: string[] = [];
    const supabase = {
      from(table: string) {
        queried.push(table);
        const chain: Record<string, unknown> = {};
        const self = () => chain;
        chain.select = self;
        chain.eq = self;
        chain.not = self;
        chain.is = self;
        chain.then = (resolve: (v: unknown) => void) =>
          resolve(table === "projects" ? { count: 3, error: null } : { count: null, error: { message: "denied" } });
        return chain;
      },
    };
    const counts = await getDashboardCounts(supabase as never, "org", { projects: true, leads: false, deals: true });
    expect(counts).toEqual({ projects: 3, leads: null, dealsWon: null, dealsOpen: null });
    expect(queried).not.toContain("leads");
  });
});
