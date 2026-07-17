import { describe, expect, it } from "bun:test";
import type { ChatMessage } from "../src/ai.ts";
import type { ContextManager } from "../src/context.ts";
import { recordAlarmDeliveryInContext } from "../src/scheduled-context.ts";

describe("alarm delivery context", () => {
  it("agrega el evento y el texto exacto enviado en una sola operación", () => {
    let capturedJid = "";
    let capturedMessages: ChatMessage[] = [];
    const fakeContext = {
      addMessages(jid: string, messages: ChatMessage[]) {
        capturedJid = jid;
        capturedMessages = messages;
      },
    } as unknown as ContextManager;

    recordAlarmDeliveryInContext(
      fakeContext,
      "521234@s.whatsapp.net",
      "Tomar medicamento",
      "jueves",
      "⏰ Recuerda tomar tu medicamento.",
      new Date("2026-07-16T18:30:00Z"),
    );

    expect(capturedJid).toBe("521234@s.whatsapp.net");
    expect(capturedMessages).toHaveLength(2);
    expect(capturedMessages[0]?.role).toBe("user");
    expect(capturedMessages[0]?.content).toContain("Tomar medicamento");
    expect(capturedMessages[0]?.content).toContain("America/Mexico_City");
    expect(capturedMessages[1]).toEqual({
      role: "assistant",
      content: "⏰ Recuerda tomar tu medicamento.",
    });
  });
});
