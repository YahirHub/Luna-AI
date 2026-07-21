/** JIDs de grupos de WhatsApp terminan en @g.us. */
export function isWhatsAppGroupJid(jid: string | null | undefined): boolean {
  return typeof jid === "string" && jid.toLowerCase().endsWith("@g.us");
}
