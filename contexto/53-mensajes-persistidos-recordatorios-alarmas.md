# 53 — Mensajes persistidos para recordatorios y alarmas

## Fecha

2026-07-17

## Problema observado

Un recordatorio se creó y se disparó correctamente, pero WhatsApp recibió únicamente:

```text
⏰ RECORDATORIO
```

El cuerpo desaparecía porque la entrega sustituía el texto de respaldo por cualquier respuesta del proveedor, incluso una cadena vacía. Además, el recordatorio almacenaba únicamente el texto crudo y, a diferencia de las alarmas, su entrega no se incorporaba al contexto persistente.

## Objetivo

- Definir desde la creación el mensaje final de cada recordatorio y alarma.
- Conservar la personalidad de Luna aunque el proveedor LLM no esté disponible en el futuro.
- Permitir que el modelo adapte el mensaje al dispararse, sin cambiar la acción ni datos importantes.
- Impedir cuerpos vacíos o notificaciones que solo repitan el título.
- Registrar también los recordatorios entregados dentro del contexto del usuario.
- Mantener compatibilidad con archivos persistentes creados por versiones anteriores.

## Implementación

### Mensaje preparado desde la creación

Los tipos `Reminder` y `RecurringAlarm` incorporan:

```ts
deliveryMessage: string;
```

Las herramientas `create_reminder` y `create_alarm` solicitan `delivery_message`, un texto autocontenido escrito con la personalidad de Luna. Si el modelo lo omite, devuelve un valor vacío o solo escribe un título genérico, el sistema genera localmente:

```text
¡Oye! 😊 Te recuerdo: <contenido>
¡Es hora! ⏰ <contenido>
```

### Compatibilidad con registros anteriores

Al cargar `reminders.json` o `alarms.json` dentro del sandbox de un usuario, los elementos que no contienen `deliveryMessage` reciben el fallback local y se vuelven a persistir. No existe migración desde el antiguo `persistent/reminders.json` global.

### Entrega independiente del LLM

`deliverScheduledMessage()` ya no requiere obligatoriamente modelo ni configuración LLM.

- Con LLM disponible: recibe el contenido obligatorio y el mensaje persistido; puede usarlo o reformularlo.
- Sin LLM: envía directamente `deliveryMessage`.
- Si el LLM falla: usa `deliveryMessage`.
- Si devuelve una cadena vacía o únicamente el título: usa `deliveryMessage`.
- Si repite el título antes del cuerpo: elimina el título duplicado.

El mensaje persistido es la fuente de verdad y no puede ser reemplazado por una salida vacía.

### Contexto posterior a la entrega

Después de que WhatsApp confirma un recordatorio, se agregan dos mensajes al contexto del usuario:

1. Evento automático con texto, fecha, hora programada y fecha/hora real de entrega en `America/Mexico_City`.
2. Texto exacto enviado por Luna.

Las alarmas conservan la misma estrategia que ya tenían.

## Archivos principales

- `src/scheduled-copy.ts`
- `src/scheduled-messages.ts`
- `src/scheduled-context.ts`
- `src/reminder.ts`
- `src/alarm.ts`
- `src/bot.ts`
- `src/context.ts`
- `__tests__/scheduled-copy.test.ts`
- `__tests__/scheduled-messages.test.ts`
- `__tests__/scheduled-context.test.ts`
- `__tests__/reminder.test.ts`
- `__tests__/alarm.test.ts`

## Pruebas realizadas

```text
bunx tsc --noEmit
bun test
```

Resultado:

```text
295 pass
0 fail
630 expect() calls
31 archivos de prueba
```

Casos cubiertos:

- Persistencia de mensajes preparados.
- Reinicio del manager.
- Migración de recordatorios antiguos.
- Fallback local con personalidad.
- Respuesta vacía del modelo.
- Respuesta que solo repite `⏰ RECORDATORIO`.
- Eliminación de títulos duplicados.
- Registro del recordatorio entregado dentro del contexto.
