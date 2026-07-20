import { describe, expect, it } from "bun:test";
import type { MessagingTransport, TransportActivitySession } from "../src/transports/types.ts";
import { startActivity } from "../src/messaging.ts";

function mockTransport(states: string[]): MessagingTransport {
  return {
    id: "test",
    label: "Test",
    send: async () => "sent",
    startActivity: async (): Promise<TransportActivitySession> => {
      states.push("start");
      return {
        refresh: async () => { states.push("refresh"); },
        stop: async () => { states.push("stop"); },
      };
    },
    markRead: async () => undefined,
    deleteMessage: async () => undefined,
  };
}

describe("actividad de transporte", () => {
  it("delega la actividad larga al adaptador activo", async () => {
    const states: string[] = [];
    const transport = mockTransport(states);
    const session = await startActivity(transport, "conversation-1", 60_000);
    expect(states).toEqual(["start"]);

    await session.refresh();
    expect(states).toEqual(["start", "refresh"]);

    await session.stop();
    expect(states.at(-1)).toBe("stop");
  });
});
