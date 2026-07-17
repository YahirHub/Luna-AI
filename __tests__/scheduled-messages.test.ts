import { describe, expect, it } from "bun:test";
import { selectScheduledMessageBody } from "../src/scheduled-messages.ts";

describe("scheduled message body selection", () => {
  const fallback = "¡Oye! 😊 Te recuerdo: Tomar medicamentos 💊";

  it("no permite que una respuesta vacía borre el mensaje persistido", () => {
    expect(selectScheduledMessageBody("", fallback, "⏰ RECORDATORIO")).toBe(fallback);
    expect(selectScheduledMessageBody("   ", fallback, "⏰ RECORDATORIO")).toBe(fallback);
  });

  it("usa el fallback cuando el modelo solo repite el título", () => {
    expect(
      selectScheduledMessageBody(
        "⏰ RECORDATORIO",
        fallback,
        "⏰ RECORDATORIO",
      ),
    ).toBe(fallback);
  });

  it("elimina el título repetido y conserva el cuerpo útil", () => {
    expect(
      selectScheduledMessageBody(
        "⏰ RECORDATORIO\n\n¡Oye! Ya es hora de tomar tus medicamentos 💊",
        fallback,
        "⏰ RECORDATORIO",
      ),
    ).toBe("¡Oye! Ya es hora de tomar tus medicamentos 💊");
  });
});
