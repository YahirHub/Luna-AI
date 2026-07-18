import { describe, expect, it } from "bun:test";
import type { WASocket } from "@whiskeysockets/baileys";
import {
  getPendingWhatsAppMessageCount,
  sendWhatsAppMessage,
  setMessagingSocket,
} from "../src/messaging.ts";

function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error("timeout"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("WhatsApp resilient queue", () => {
  it("conserva un mensaje si el socket se cierra y lo envía al reconectar", async () => {
    const jid = "user@s.whatsapp.net";
    const failedSock = {
      sendPresenceUpdate: async () => undefined,
      sendMessage: async () => {
        const error = new Error("Connection Closed") as Error & { output?: { statusCode?: number } };
        error.output = { statusCode: 428 };
        throw error;
      },
    } as unknown as WASocket;

    setMessagingSocket(failedSock);
    const result = await sendWhatsAppMessage(
      failedSock,
      jid,
      { text: "mensaje pendiente" },
      { minDelayMs: 0, maxDelayMs: 0 },
    );

    expect(result).toBe("queued");
    expect(getPendingWhatsAppMessageCount()).toBe(1);

    const sent: string[] = [];
    const recoveredSock = {
      sendPresenceUpdate: async () => undefined,
      sendMessage: async (_jid: string, content: { text?: string }) => {
        sent.push(content.text ?? "");
        return {};
      },
    } as unknown as WASocket;

    setMessagingSocket(recoveredSock);
    await waitUntil(() => getPendingWhatsAppMessageCount() === 0);
    expect(sent).toEqual(["mensaje pendiente"]);
  });
});
