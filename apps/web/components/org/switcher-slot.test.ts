import { describe, expect, it } from "vitest";
import { isSwitcherHiddenPath } from "./switcher-slot";

describe("isSwitcherHiddenPath", () => {
  it.each(["/onboarding", "/select-organization", "/onboarding/", "/select-organization/x"])("masque sur %s", (p) => {
    expect(isSwitcherHiddenPath(p)).toBe(true);
  });
  it.each(["/dashboard", "/", "/onboardingx", "/settings/onboarding", "/login"])("affiche sur %s", (p) => {
    expect(isSwitcherHiddenPath(p)).toBe(false);
  });
});
