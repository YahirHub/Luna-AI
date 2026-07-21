import type { ContextManager } from "./context.ts";

function formatDeliveryTimestamp(deliveredAt: Date): string {
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Mexico_City",
    dateStyle: "full",
    timeStyle: "short",
  }).format(deliveredAt);
}

/** Registra en el historial persistente un recordatorio confirmado por WhatsApp. */
export function recordReminderDeliveryInContext(
  contextManager: ContextManager,
  jid: string,
  reminderText: string,
  scheduledDate: string,
  scheduledTime: string,
  deliveredText: string,
  deliveredAt = new Date(),
): void {
  const localTimestamp = formatDeliveryTimestamp(deliveredAt);

  contextManager.addMessages(jid, [
    {
      role: "user",
      content: [
        "[Evento automático confirmado]",
        `Se activó y entregó el recordatorio \"${reminderText}\".`,
        `Programado para: ${scheduledDate} a las ${scheduledTime}.`,
        `Entrega confirmada: ${localTimestamp} (America/Mexico_City).`,
      ].join("\n"),
    },
    { role: "assistant", content: deliveredText },
  ]);
}

/** Registra en el historial persistente una alarma ya confirmada por WhatsApp. */
export function recordAlarmDeliveryInContext(
  contextManager: ContextManager,
  jid: string,
  alarmText: string,
  dayName: string,
  deliveredText: string,
  deliveredAt = new Date(),
): void {
  const localTimestamp = formatDeliveryTimestamp(deliveredAt);

  contextManager.addMessages(jid, [
    {
      role: "user",
      content: [
        "[Evento automático confirmado]",
        `Se activó y entregó la alarma recurrente \"${alarmText}\".`,
        `Día programado: ${dayName}.`,
        `Entrega confirmada: ${localTimestamp} (America/Mexico_City).`,
      ].join("\n"),
    },
    { role: "assistant", content: deliveredText },
  ]);
}
