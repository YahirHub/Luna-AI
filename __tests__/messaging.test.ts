import { describe, expect, it } from "bun:test";
import type { MessagingTransport } from "../src/transports/types.ts";
import { startContinuousTyping } from "../src/messaging.ts";

describe("continuous typing", () => {
  it("activa composing y termina en paused sin añadir retrasos", async () => {
    const states: string[] = [];
    const transport = {
      id: "test", connected: true,
      send: async () => "sent" as const,
      sendPresence: async (_jid: string, state: "composing" | "paused") => { states.push(state); },
      markRead: async () => undefined,
      deleteMessage: async () => undefined,
    } satisfies MessagingTransport;
    const session = await startContinuousTyping(transport, "user", 60_000);
    expect(states).toEqual(["composing"]);
    await session.refresh();
    expect(states).toEqual(["composing", "composing"]);
    await session.stop();
    expect(states.at(-1)).toBe("paused");
  });
});
