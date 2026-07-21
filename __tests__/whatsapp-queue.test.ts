import { describe, expect, it } from "bun:test";
import type { WASocket } from "@whiskeysockets/baileys";
import { BaileysTransport } from "../src/transports/baileys/adapter.ts";

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

describe("Baileys resilient queue", () => {
  it("conserva un mensaje si el socket se cierra y lo envía al reconectar", async () => {
    const transport = new BaileysTransport();
    const failedSock = {
      sendPresenceUpdate: async () => undefined,
      sendMessage: async () => {
        const error = new Error("Connection Closed") as Error & { output?: { statusCode?: number } };
        error.output = { statusCode: 428 };
        throw error;
      },
    } as unknown as WASocket;
    transport.attachSocket(failedSock);
    const result = await transport.send("user", { text: "mensaje pendiente" }, { minDelayMs: 0, maxDelayMs: 0 });
    expect(result).toBe("queued");
    expect(transport.pendingCount).toBe(1);
    const sent: string[] = [];
    transport.attachSocket({
      sendPresenceUpdate: async () => undefined,
      sendMessage: async (_jid: string, content: { text?: string }) => { sent.push(content.text ?? ""); return {}; },
    } as unknown as WASocket);
    await waitUntil(() => transport.pendingCount === 0);
    expect(sent).toEqual(["mensaje pendiente"]);
  });
});
