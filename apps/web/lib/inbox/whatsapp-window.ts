/**
 * Fenêtre de conversation WhatsApp : ouverte si le contact a écrit dans ce fil il y a MOINS de 24 heures (même règle que `message_send_claim` et que
 * `conversation_reply`, qui font foi : ce calcul ne sert qu'à griser le champ de réponse, le serveur refuse de toute façon hors fenêtre).
 */
export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isWhatsAppWindowOpen(messages: ReadonlyArray<{ direction: string; received_at: string | null }>, now: Date = new Date()): boolean {
  return messages.some((message) => {
    if (message.direction !== "inbound" || message.received_at === null) return false;
    const at = Date.parse(message.received_at);
    return Number.isFinite(at) && at <= now.getTime() + 60_000 && now.getTime() - at < WHATSAPP_WINDOW_MS;
  });
}
