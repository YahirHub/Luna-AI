import type { MessagingTransport, TransportOutboundContent, TransportSendOptions } from "./transports/types.ts";

export interface ContinuousTypingSession {
  refresh: () => Promise<void>;
  stop: () => Promise<void>;
}

export async function sendMessage(
  transport: MessagingTransport,
  conversationId: string,
  content: TransportOutboundContent,
  options: TransportSendOptions = {},
): Promise<"sent" | "queued"> {
  return transport.send(conversationId, content, options);
}

/** Alias conservado para módulos antiguos; no contiene lógica específica de SDK. */
export const sendWhatsAppMessage = sendMessage;

export async function sendWithTyping(
  transport: MessagingTransport,
  conversationId: string,
  text: string,
  minDelayMs = 1_200,
  maxDelayMs = 2_800,
): Promise<"sent" | "queued"> {
  return transport.send(conversationId, { text }, { minDelayMs, maxDelayMs });
}

export async function startContinuousTyping(
  transport: MessagingTransport,
  conversationId: string,
  refreshIntervalMs = 8_000,
): Promise<ContinuousTypingSession> {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const refresh = async () => {
    if (!stopped) await transport.sendPresence(conversationId, "composing");
  };
  await refresh();
  timer = setInterval(() => { void refresh(); }, refreshIntervalMs);
  return {
    refresh,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      await transport.sendPresence(conversationId, "paused");
    },
  };
}
