import { describe, expect, it } from "bun:test";
import type { ChatMessage } from "../src/ai.ts";
import type { ContextManager } from "../src/context.ts";
import {
  recordAlarmDeliveryInContext,
  recordReminderDeliveryInContext,
} from "../src/scheduled-context.ts";

function captureContext(): {
  context: ContextManager;
  getJid(): string;
  getMessages(): ChatMessage[];
} {
  let capturedJid = "";
  let capturedMessages: ChatMessage[] = [];
  const context = {
    addMessages(jid: string, messages: ChatMessage[]) {
      capturedJid = jid;
      capturedMessages = messages;
    },
  } as unknown as ContextManager;

  return {
    context,
    getJid: () => capturedJid,
    getMessages: () => capturedMessages,
  };
}

describe("scheduled delivery context", () => {
  it("agrega la alarma y el texto exacto enviado en una sola operación", () => {
    const captured = captureContext();

    recordAlarmDeliveryInContext(
      captured.context,
      "521234@s.whatsapp.net",
      "Tomar medicamento",
      "jueves",
      "⏰ Recuerda tomar tu medicamento.",
      new Date("2026-07-16T18:30:00Z"),
    );

    expect(captured.getJid()).toBe("521234@s.whatsapp.net");
    expect(captured.getMessages()).toHaveLength(2);
    expect(captured.getMessages()[0]?.content).toContain("Tomar medicamento");
    expect(captured.getMessages()[1]).toEqual({
      role: "assistant",
      content: "⏰ Recuerda tomar tu medicamento.",
    });
  });

  it("agrega el recordatorio entregado al contexto persistente", () => {
    const captured = captureContext();

    recordReminderDeliveryInContext(
      captured.context,
      "521234@s.whatsapp.net",
      "Tomar medicamentos 💊",
      "2026-07-17",
      "10:37",
      "⏰ RECORDATORIO\n\n¡Oye! 😊 Ya es hora de tomar tus medicamentos 💊",
      new Date("2026-07-17T16:37:00Z"),
    );

    const messages = captured.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toContain("Tomar medicamentos 💊");
    expect(messages[0]?.content).toContain("2026-07-17 a las 10:37");
    expect(messages[0]?.content).toContain("America/Mexico_City");
    expect(messages[1]?.content).toContain("Ya es hora de tomar tus medicamentos");
  });
});
