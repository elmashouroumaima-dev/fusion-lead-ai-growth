import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));

import { PlanUsageCard } from "./plan-usage-card";

const rows = [{ metric: "contacts", used: 0, limit: 50000, near_limit: false }] as never;
const render = async (locale: "fr" | "en" | "ar") => renderToStaticMarkup(await PlanUsageCard({ rows, locale }));

describe("carte d'utilisation du plan : nombres formatés selon la langue", () => {
  it("fr : « 0 / 50 000 » (espace fine insécable), jamais « 50000 »", async () => {
    const html = await render("fr");
    expect(html).toContain("0 / 50 000");
    expect(html).not.toContain("/ 50000");
  });
  it("en : « 50,000 » ; ar : chiffres latins (comme le reste de l'application)", async () => {
    expect(await render("en")).toContain("0 / 50,000");
    expect(await render("ar")).toMatch(/0 \/ 50[٬,]000/);
  });
});
