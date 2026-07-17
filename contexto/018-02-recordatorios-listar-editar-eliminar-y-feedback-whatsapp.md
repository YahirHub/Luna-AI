# Recordatorios: listar, editar, eliminar + feedback WhatsApp + fix hallucinación

**Fecha:** 2026-07-16

## Objetivo

Corregir bug donde el AI respondía "ya quedó el recordatorio" sin llamar realmente `create_reminder`, agregar notificaciones en WhatsApp cuando se usan herramientas (recordatorios y memoria), y añadir capacidad de listar/eliminar recordatorios mediante tools del AI.

## Archivos modificados

- `src/ai.ts` — `chatCompletionWithTools` retorna `toolsCalled: string[]` en vez de `memoryModified: boolean`, acepta callback `onToolCall` que se dispara tras ejecución exitosa de cada tool
- `src/reminder.ts` — 3 tools: `create_reminder`, `delete_reminder` (busca por texto o ID), `list_reminders` (pendientes o todos). Nuevo `ReminderManager.deleteById()`, helper `findReminder()`
- `src/context.ts` — System prompt reforzado con ⚠️ sobre llamar herramientas realmente, no fingir
- `src/bot.ts` — `handleAiChat` pasa `onToolCall` que envía mensajes WhatsApp ("⏰ Creando recordatorio..."), detecta `toolsCalled.includes("memory_write")` para refrescar system prompt
- `__tests__/reminder.test.ts` — 10 tests nuevos: deleteById, delete_reminder por ID/texto/hora/errores, list_reminders básico/todos/disparados/aislamiento JID

## Decisiones técnicas

- `onToolCall` se dispara DESPUÉS de `await executeTool()`, y solo si el resultado no empieza con "Error:" — evita notificaciones falsas
- `shownNotifs` (Set) evita duplicados del mismo tipo de notificación por request
- Las notificaciones son fire-and-forget (`.catch(() => {}))` — no bloquean el flujo principal
- `delete_reminder` permite buscar por texto parcial, por hora ("15:30") o por ID (primeros 8 chars)
- `list_reminders` por defecto muestra solo pendientes; con `all: true` también incluye disparados
- Para "editar" un recordatorio: el prompt instruye al AI a eliminar el viejo con `delete_reminder` y crear uno nuevo con `create_reminder`

## Problemas resueltos

- Bug: AI fingía crear recordatorios → prompt reforzado + descripciones de tools con ⚠️
- Bug: sin feedback en WhatsApp cuando se creaba recordatorio → `onToolCall` envía mensaje
- Feature faltante: no se podían listar/eliminar recordatorios → tools `delete_reminder` + `list_reminders`

## Tests

128 tests, 0 fail. Typecheck 0 errores.
