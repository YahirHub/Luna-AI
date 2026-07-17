import { describe, expect, it } from "bun:test";
import type { WASocket } from "@whiskeysockets/baileys";
import { startContinuousTyping } from "../src/messaging.ts";

describe("continuous typing", () => {
  it("activa composing y termina en paused sin añadir retrasos", async () => {
    const states: string[] = [];
    const sock = {
      sendPresenceUpdate: async (state: string) => {
        states.push(state);
      },
    } as unknown as WASocket;

    const session = await startContinuousTyping(sock, "user@s.whatsapp.net", 60_000);
    expect(states).toEqual(["composing"]);

    await session.refresh();
    expect(states).toEqual(["composing", "composing"]);

    await session.stop();
    expect(states.at(-1)).toBe("paused");
  });
});
