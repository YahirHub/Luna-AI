# Recordatorios y hora CDMX en cada solicitud

## Objetivo
- Inyectar la hora/fecha actual de `America/Mexico_City` en cada solicitud a la API para que Luna sepa siempre qué hora es.
- Implementar sistema de recordatorios: el usuario pide "recuerdame a las X:Y algo" y el bot lo notifica a esa hora.

## Archivos modificados

| Archivo | Cambio |
|---|---|
| `src/context.ts` | Nueva función `getMexicoCityTime()` inyectada en `buildSystemPrompt` con sección `HORA Y FECHA ACTUAL`. Nueva sección `RECORDATORIOS` en system prompt explicando `create_reminder`. |
| `src/bot.ts` | `handleAiChat`: llama `refreshSystemPrompt()` antes de cada API call para hora fresca. Importa `ReminderManager`, `REMINDER_TOOLS`, `executeReminderTool`, `chatCompletion`. Crea `reminderManager`. Combina `ALL_TOOLS`. Exporta `setSocket()`. `onReminderDue()` callback con llamada a AI para formatear recordatorio + typing simulation + fallback. |
| `src/connection.ts` | Importa `setSocket` de `bot.ts`, lo llama cuando `connection === "open"`. |

## Archivos creados

| Archivo | Descripción |
|---|---|
| `src/reminder.ts` | `ReminderManager` con persistencia en `persistent/reminders.json`. Tool definition `create_reminder`. `executeReminderTool()`. Verificador periódico cada 30s con ventana `lastCheckTs` (epoch min-of-day + date) que tolera hasta 2 min de retraso sin disparar viejos. |
| `__tests__/reminder.test.ts` | 18 tests: creación, IDs únicos, fechas explícitas, markFired, getDueReminders, tool validation. |

## Decisiones técnicas

- **Hora CDMX**: `Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City" })`. Se inyecta en el system prompt que se reconstruye en cada `refreshSystemPrompt()`, llamado antes de cada `chatCompletionWithTools`.
- **Recordatorios**: `create_reminder` tool acepta `text`, `hour`, `minute`, `date` opcional. Si no hay fecha, asigna hoy si la hora no pasó, mañana si ya pasó. Store en `persistent/reminders.json`.
- **Verificador**: `setInterval` cada 30s. `lastCheckTs` + `lastCheckDate` para ventana de disparo segura que maneja cruce de medianoche y tolera retrasos.
- **Disparo**: `onReminderDue` llama a la API AI con system prompt + memoria del usuario para formatear el recordatorio como lo haría Luna. Incluye typing simulation (2-4s). Fallback envía texto plano también con typing.
- **Socket**: Referencia actualizada via `setSocket()` en `connection.ts` cada reconexión.

## Tests
114 tests, 207 expect calls, 0 fail.
