import { describe, expect, it } from "bun:test";
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

describe("cola resiliente del adaptador Baileys", () => {
  it("conserva un mensaje si el socket se cierra y lo envía al reconectar", async () => {
    const jid = "user@s.whatsapp.net";
    const transport = new BaileysTransport();
    const failedSock = {
      sendPresenceUpdate: async () => undefined,
      sendMessage: async () => {
        const error = new Error("Connection Closed") as Error & { output?: { statusCode?: number } };
        error.output = { statusCode: 428 };
        throw error;
      },
    };

    transport.setSocket(failedSock as never);
    const result = await transport.send(
      jid,
      { kind: "text", text: "mensaje pendiente" },
      { minDelayMs: 0, maxDelayMs: 0 },
    );

    expect(result).toBe("queued");
    expect(transport.getPendingCount()).toBe(1);

    const sent: string[] = [];
    const recoveredSock = {
      sendPresenceUpdate: async () => undefined,
      sendMessage: async (_jid: string, content: { text?: string }) => {
        sent.push(content.text ?? "");
        return {};
      },
    };

    transport.setSocket(recoveredSock as never);
    await waitUntil(() => transport.getPendingCount() === 0);
    expect(sent).toEqual(["mensaje pendiente"]);
  });

  it("simula escribiendo antes de cada mensaje saliente", async () => {
    const jid = "user@s.whatsapp.net";
    const transport = new BaileysTransport();
    const events: string[] = [];
    const socket = {
      sendPresenceUpdate: async (state: string) => {
        events.push(state);
      },
      sendMessage: async (_jid: string, content: { text?: string }) => {
        events.push(`message:${content.text ?? ""}`);
        return {};
      },
    };

    transport.setSocket(socket as never);
    const result = await transport.send(
      jid,
      { kind: "text", text: "hola" },
      { minDelayMs: 0, maxDelayMs: 0 },
    );

    expect(result).toBe("sent");
    expect(events).toEqual(["composing", "message:hola", "paused"]);
  });

  it("elige medio nativo o documento al enviar una ruta según MIME", async () => {
    const jid = "user@s.whatsapp.net";
    const transport = new BaileysTransport();
    const contents: Array<Record<string, unknown>> = [];
    const socket = {
      sendPresenceUpdate: async () => undefined,
      sendMessage: async (_jid: string, content: Record<string, unknown>) => {
        contents.push(content);
        return {};
      },
    };

    transport.setSocket(socket as never);
    await transport.send(
      jid,
      {
        kind: "file",
        bytes: new Uint8Array([1, 2, 3]),
        fileName: "captura.png",
        mimeType: "image/png",
        mode: "auto",
      },
      { minDelayMs: 0, maxDelayMs: 0 },
    );
    await transport.send(
      jid,
      {
        kind: "file",
        bytes: new Uint8Array([4, 5, 6]),
        fileName: "informe.pdf",
        mimeType: "application/pdf",
        mode: "auto",
      },
      { minDelayMs: 0, maxDelayMs: 0 },
    );

    expect(contents[0]).toHaveProperty("image");
    expect(contents[0]).not.toHaveProperty("document");
    expect(contents[1]).toHaveProperty("document");
    expect(contents[1]?.fileName).toBe("informe.pdf");
  });

});
