import { describe, expect, it } from "bun:test";
import {
  buildAlarmDeliveryMessage,
  buildReminderDeliveryMessage,
  normalizePreparedScheduledMessage,
} from "../src/scheduled-copy.ts";

describe("scheduled copy", () => {
  it("crea un mensaje local de recordatorio con personalidad", () => {
    expect(buildReminderDeliveryMessage("Tomar medicamentos 💊")).toBe(
      "¡Oye! 😊 Te recuerdo: Tomar medicamentos 💊",
    );
  });

  it("crea un mensaje local de alarma con personalidad", () => {
    expect(buildAlarmDeliveryMessage("Tomar agua")).toBe(
      "¡Es hora! ⏰ Tomar agua",
    );
  });

  it("usa el fallback cuando el modelo no preparó un mensaje útil", () => {
    const fallback = buildReminderDeliveryMessage("Comprar leche");
    expect(normalizePreparedScheduledMessage("", fallback)).toBe(fallback);
    expect(normalizePreparedScheduledMessage("⏰ RECORDATORIO", fallback)).toBe(fallback);
  });

  it("conserva un mensaje autocontenido preparado por el modelo", () => {
    const fallback = buildReminderDeliveryMessage("Comprar leche");
    expect(
      normalizePreparedScheduledMessage(
        "¡Ey! 😊 No olvides comprar la leche antes de volver a casa.",
        fallback,
      ),
    ).toBe("¡Ey! 😊 No olvides comprar la leche antes de volver a casa.");
  });
});
