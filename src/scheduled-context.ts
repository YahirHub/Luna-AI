import type { ContextManager } from "./context.ts";

/** Registra en el historial persistente una alarma ya confirmada por WhatsApp. */
export function recordAlarmDeliveryInContext(
  contextManager: ContextManager,
  jid: string,
  alarmText: string,
  dayName: string,
  deliveredText: string,
  deliveredAt = new Date(),
): void {
  const localTimestamp = new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Mexico_City",
    dateStyle: "full",
    timeStyle: "short",
  }).format(deliveredAt);

  contextManager.addMessages(jid, [
    {
      role: "user",
      content: [
        "[Evento automático confirmado]",
        `Se activó y entregó la alarma recurrente "${alarmText}".`,
        `Día programado: ${dayName}.`,
        `Entrega confirmada: ${localTimestamp} (America/Mexico_City).`,
      ].join("\n"),
    },
    { role: "assistant", content: deliveredText },
  ]);
}
