import type { WASocket } from "@whiskeysockets/baileys";
import { delay } from "./utils.ts";

/** Envía texto mostrando el estado "escribiendo" durante un intervalo breve. */
export async function sendWithTyping(
  sock: WASocket,
  jid: string,
  text: string,
  minDelayMs = 3_000,
  maxDelayMs = 5_000,
): Promise<void> {
  const spread = Math.max(0, maxDelayMs - minDelayMs);
  const waitMs = minDelayMs + Math.floor(Math.random() * (spread + 1));

  await sock.sendPresenceUpdate("composing", jid).catch(() => {});
  try {
    await delay(waitMs);
    await sock.sendMessage(jid, { text });
  } finally {
    await sock.sendPresenceUpdate("paused", jid).catch(() => {});
  }
}
