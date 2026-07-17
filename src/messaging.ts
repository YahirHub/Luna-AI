import type { WASocket } from "@whiskeysockets/baileys";
import { delay } from "./utils.ts";

export interface ContinuousTypingSession {
  refresh: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Mantiene visible el estado "escribiendo" durante una operación real larga.
 * No agrega retrasos artificiales: solo renueva la presencia hasta finalizar.
 */
export async function startContinuousTyping(
  sock: WASocket,
  jid: string,
  refreshIntervalMs = 8_000,
): Promise<ContinuousTypingSession> {
  let active = true;
  let refreshInFlight = false;

  const refresh = async (): Promise<void> => {
    if (!active || refreshInFlight) return;
    refreshInFlight = true;
    try {
      await sock.sendPresenceUpdate("composing", jid).catch(() => {});
    } finally {
      refreshInFlight = false;
    }
  };

  await refresh();
  const timer = setInterval(() => {
    void refresh();
  }, Math.max(2_000, refreshIntervalMs));
  (timer as unknown as { unref?: () => void }).unref?.();

  return {
    refresh,
    stop: async () => {
      if (!active) return;
      active = false;
      clearInterval(timer);
      await sock.sendPresenceUpdate("paused", jid).catch(() => {});
    },
  };
}

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
