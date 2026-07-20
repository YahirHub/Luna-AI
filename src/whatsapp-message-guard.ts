/** Sufijo utilizado por WhatsApp/Baileys para identificar chats de grupo. */
const WHATSAPP_GROUP_JID_SUFFIX = "@g.us";

/**
 * Devuelve true cuando el JID pertenece a un grupo de WhatsApp.
 *
 * Luna opera temporalmente solo en chats privados. Los grupos se descartan
 * antes de autenticación, lectura, multimedia, comandos, LLM o cualquier
 * mutación de estado para impedir que un JID compartido suplante la sesión
 * privada de un usuario.
 */
export function isWhatsAppGroupJid(jid: string | null | undefined): boolean {
  return typeof jid === "string" && jid.endsWith(WHATSAPP_GROUP_JID_SUFFIX);
}
