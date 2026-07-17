/** Longitud máxima persistida para el cuerpo de una notificación programada. */
export const MAX_SCHEDULED_DELIVERY_MESSAGE_LENGTH = 1_200;

const GENERIC_ONLY_MESSAGES = new Set([
  "recordatorio",
  "alarma",
  "alarma recurrente",
  "recordatorio programado",
]);

/** Normaliza espacios sin destruir saltos de línea intencionales. */
function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Texto seguro para incrustar en el mensaje de respaldo. */
function normalizeSubject(text: string): string {
  const normalized = normalizeWhitespace(text);
  return normalized || "revisar tu recordatorio pendiente";
}

/** Mensaje local de Luna usado cuando el modelo no definió uno. */
export function buildReminderDeliveryMessage(text: string): string {
  return `¡Oye! 😊 Te recuerdo: ${normalizeSubject(text)}`;
}

/** Mensaje local de Luna usado cuando el modelo no definió uno. */
export function buildAlarmDeliveryMessage(text: string): string {
  return `¡Es hora! ⏰ ${normalizeSubject(text)}`;
}

/**
 * Conserva el mensaje preparado por el modelo si es útil; de lo contrario usa
 * un texto local determinista. Siempre devuelve un cuerpo autocontenido.
 */
export function normalizePreparedScheduledMessage(
  value: unknown,
  fallback: string,
): string {
  const normalizedFallback = normalizeWhitespace(fallback).slice(
    0,
    MAX_SCHEDULED_DELIVERY_MESSAGE_LENGTH,
  );
  if (typeof value !== "string") return normalizedFallback;

  const candidate = normalizeWhitespace(value).slice(
    0,
    MAX_SCHEDULED_DELIVERY_MESSAGE_LENGTH,
  );
  if (!candidate) return normalizedFallback;

  const plain = candidate
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "")
    .toLocaleLowerCase("es-MX");
  if (!plain || GENERIC_ONLY_MESSAGES.has(plain)) return normalizedFallback;

  return candidate;
}
