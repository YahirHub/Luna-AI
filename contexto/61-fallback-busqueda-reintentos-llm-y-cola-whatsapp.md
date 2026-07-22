# 61 — Fallback de búsqueda, reintentos LLM y cola resiliente de WhatsApp

# Fecha

2026-07-18

# Punto de partida

Este cambio parte del runtime genérico de subagentes inspirado en Codewolf registrado en `contexto/60-runtime-agentico-generico-y-spawn-agents.md`.

# Problemas observados

1. Un proveedor de búsqueda podía fallar por rate limit o devolver resultados inutilizables. El runtime ya continuaba con el siguiente proveedor configurado, pero el fallo intermedio se registraba como `ERROR`, generando ruido y pudiendo confundirse con un fallo final de `web_search`.
2. El proveedor LLM podía responder con errores HTTP 400 transitorios como `Upstream request failed`. Estos no se consideraban reintentables aunque representaran una caída temporal del upstream.
3. Una respuesta HTTP 200 vacía, sin texto ni `tool_calls`, podía hacer terminar un subagente sin respuesta útil en lugar de reintentar la solicitud al proveedor.
4. Los mensajes de progreso y varias rutas de entrega llamaban directamente a `sock.sendMessage`. Durante una desconexión de WhatsApp (por ejemplo Boom 428 `Connection Closed`) esas llamadas propagaban excepciones al flujo de agentes aun cuando la tarea de investigación hubiese terminado correctamente.
5. Los logs estructurados eran difíciles de distinguir visualmente entre búsqueda, fetch, agentes, LLM y WhatsApp.

# Soluciones implementadas

## Fallback multiproveedor de búsqueda

- `runWebSearchWithFallback` conserva el orden de proveedores configurado.
- Si un motor falla, queda rate-limited o devuelve cero resultados utilizables, la misma consulta continúa automáticamente con el siguiente proveedor habilitado.
- Un fallo intermedio ahora se registra como `WARN` (`provider_failed_fallback`) e incluye el siguiente proveedor que se intentará.
- El modelo solo recibe `Error:` cuando todos los motores disponibles fallaron.
- Tavily mantiene su manejo específico de HTTP 429: si el `Retry-After` es corto puede reintentar; si exige una espera larga se salta al siguiente motor sin bloquear toda la tarea.

## Reintentos del proveedor LLM

`src/ai.ts` ahora aplica reintentos configurables a:

- timeouts y errores de red;
- HTTP 408, 409, 425, 429 y 5xx;
- HTTP 400 que indiquen una falla transitoria del upstream, incluyendo `Upstream request failed`, proveedor no disponible, gateway, conexión cerrada o timeout del proveedor;
- respuestas HTTP 200 sin contenido ni `tool_calls`.

Después de agotar los intentos se lanza `LlmRetriesExhaustedError`. El mensaje o subagente actual se aborta de forma controlada; los demás subagentes paralelos pueden continuar mediante `Promise.allSettled`.

Variables:

```text
LUNA_LLM_RETRY_ATTEMPTS=3
LUNA_LLM_RETRY_BASE_MS=1500
```

## Cola resiliente de WhatsApp

Se centralizaron los mensajes salientes en `src/messaging.ts`.

- `setMessagingSocket()` recibe el socket activo desde `bot.setSocket()`.
- `sendWhatsAppMessage()` es la ruta común para texto y medios.
- Todos los mensajes pasan por una breve simulación `composing` antes del envío.
- Si `sendMessage` devuelve una caída de conexión como 408/428 o `Connection Closed`, el mensaje permanece temporalmente en memoria.
- El flujo que originó el mensaje se libera para que una desconexión no bloquee un agente, el lock del chat o una tarea larga.
- Al reconectar, `setMessagingSocket(newSocket)` vacía automáticamente la cola en orden.
- Los errores de envío no relacionados con conectividad tienen reintentos con backoff.
- Se migraron a la cola las respuestas finales, progreso de subagentes, confirmaciones de tools, descargas de Whisper, OCR/transcripción y `whatsapp_send` para texto y artefactos.
- La operación interna de borrar un mensaje sensible recibido sigue usando directamente la acción `delete`, ya que no es una entrega de contenido y no debe diferirse para una reconexión posterior.

Variables:

```text
LUNA_WHATSAPP_MIN_DELAY_MS=1200
LUNA_WHATSAPP_MAX_DELAY_MS=2800
LUNA_WHATSAPP_SEND_RETRY_ATTEMPTS=3
```

La cola de WhatsApp es temporal en memoria. Alarmas y recordatorios conservan además sus mecanismos de persistencia y reintento existentes.

## Logs con colores

`src/debug.ts` distingue subsistemas mediante colores ANSI:

- búsqueda: cian;
- fetch/read_url: magenta;
- agentes: azul;
- LLM: verde;
- WhatsApp: amarillo;
- errores definitivos: rojo.

Se agregó `LUNA_DEBUG_COLORS=false` para desactivar colores y se corrigió la redacción de secretos para no ocultar URLs normales con cadenas como `api-pricing`.

# Archivos principales modificados

- `src/ai.ts`
- `src/debug.ts`
- `src/search/search-runtime.ts`
- `src/messaging.ts`
- `src/bot.ts`
- `src/tools/whatsapp-tools.ts`
- `README.md`
- `__tests__/llm-retry.test.ts`
- `__tests__/search-runtime.test.ts`
- `__tests__/whatsapp-queue.test.ts`

# Regresiones protegidas

No se modificó la lógica de negocio de:

- `ReminderManager`;
- `AlarmManager`;
- confirmaciones autoritativas de herramientas;
- persistencia por JID;
- runtime `spawn_agents` y aislamiento de investigadores.

# Pruebas agregadas

- fallback inmediato a otro proveedor cuando Tavily responde 429 con cooldown largo;
- reintento de HTTP 400 `Upstream request failed` y recuperación posterior;
- aborto después de agotar los intentos LLM;
- reintento de respuestas HTTP 200 vacías;
- conservación de un mensaje ante Boom 428 y envío automático al establecer un nuevo socket.

