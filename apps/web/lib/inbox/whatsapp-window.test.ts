import { describe, expect, it } from "vitest";
import { isWhatsAppWindowOpen } from "./whatsapp-window";

const NOW = new Date("2026-11-21T12:00:00Z");
const at = (hoursAgo: number, direction = "inbound") => ({ direction, received_at: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString() });

describe("fenêtre de 24 h WhatsApp", () => {
  it("ouverte : un message du contact il y a moins de 24 h (23 h 59 min comprise)", () => {
    expect(isWhatsAppWindowOpen([at(1)], NOW)).toBe(true);
    expect(isWhatsAppWindowOpen([at(23.98)], NOW)).toBe(true);
  });
  it("fermée : 24 h pile, plus ancien, aucun message, ou seulement des messages sortants", () => {
    expect(isWhatsAppWindowOpen([at(24)], NOW)).toBe(false);
    expect(isWhatsAppWindowOpen([at(30)], NOW)).toBe(false);
    expect(isWhatsAppWindowOpen([], NOW)).toBe(false);
    expect(isWhatsAppWindowOpen([at(1, "outbound")], NOW)).toBe(false);
  });
  it("date absente, illisible ou dans le futur lointain : fermée (jamais ouverte par erreur)", () => {
    expect(isWhatsAppWindowOpen([{ direction: "inbound", received_at: null }], NOW)).toBe(false);
    expect(isWhatsAppWindowOpen([{ direction: "inbound", received_at: "pas une date" }], NOW)).toBe(false);
    expect(isWhatsAppWindowOpen([at(-5)], NOW)).toBe(false);
  });
  it("un ancien message hors fenêtre ne ferme pas la fenêtre ouverte par un message récent", () => {
    expect(isWhatsAppWindowOpen([at(50), at(2)], NOW)).toBe(true);
  });
});
