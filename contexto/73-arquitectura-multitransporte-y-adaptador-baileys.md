# 73 — Arquitectura multitransporte y adaptador Baileys

# Fecha

2026-07-20

# Objetivo

Desacoplar el núcleo de Luna AI del SDK de mensajería para que Baileys pueda sustituirse por otro cliente de WhatsApp o añadirse un transporte como Telegram sin reescribir la lógica principal del asistente.

# Decisión arquitectónica

El núcleo trabaja únicamente con contratos propios:

- `MessagingTransport`: salida de texto/archivos, actividad opcional, marcado de lectura y borrado best-effort.
- `TransportIncomingMessage`: representación normalizada de un mensaje entrante.
- `TransportRunner`: autenticación, ciclo de vida, reconexión y entrega de mensajes normalizados al núcleo.

Los contratos viven en `src/transports/types.ts`. La selección del cliente se centraliza en `src/transports/factory.ts` y el arranque genérico en `src/connection.ts`. La factoría usa loaders dinámicos para no inicializar SDKs de transportes inactivos.

El paquete también se renombró internamente de `whatsapp-bot` a `luna-ai`. Actualmente se soporta un transporte activo por proceso. `baileys` es el transporte predeterminado y `whatsapp` funciona como alias. También puede elegirse mediante `LUNA_TRANSPORT`. Telegram no está implementado todavía; la arquitectura queda preparada para registrar un runner/adaptador nuevo.

# Aislamiento de Baileys

Toda dependencia de `@whiskeysockets/baileys`, `WASocket` y `WAMessage` queda confinada a:

- `src/transports/baileys/adapter.ts`
- `src/transports/baileys/runner.ts`

`src/bot.ts`, `src/commands.ts`, `src/media.ts`, `src/messaging.ts` y `src/scheduled-messages.ts` ya no importan Baileys.

El runner Baileys es responsable de sesión, QR/pairing, socket, reconexión, filtro temprano de grupos y normalización de mensajes. El adaptador es responsable de cola de salida, presencia, reintentos, descarga de medios y conversión del mensaje genérico al formato nativo de Baileys.

El socket solo se publica al adaptador cuando Baileys confirma `connection=open`; durante el handshake inicial la cola permanece pendiente y no intenta enviar.

# Escritura y actividad

Se eliminó del núcleo cualquier implementación directa de `composing`/`paused`. `src/messaging.ts` únicamente delega al transporte.

En Baileys, cada elemento de la cola de salida ejecuta:

1. `composing`;
2. espera configurada;
3. envío real;
4. `paused`.

Esto aplica a texto y archivos. Para operaciones largas el núcleo puede pedir `startActivity`, pero su representación es decisión exclusiva del adaptador. Un futuro Telegram podría mapearlo a `sendChatAction` sin cambios en el núcleo.

# Envío genérico de archivos

La herramienta anterior específica de WhatsApp fue reemplazada por `message_send` en `src/tools/messaging-tools.ts`.

- `text`: envía texto por el transporte activo.
- `path`: resuelve una ruta segura dentro del workdir.
- Si la ruta es carpeta, se genera un ZIP.
- Si es archivo, se detecta MIME y se envía con `mode=auto`.
- La protección de ZIPs con posibles credenciales se conserva.
- El adaptador decide medio nativo o documento.

Política actual de Baileys:

- imagen/audio/video de hasta 10 MiB: medio nativo;
- otros MIME o archivos mayores: documento.

# Mensajes entrantes y multimedia

`src/media.ts` consume `TransportIncomingMedia` y una función `download()` provista por cada adaptador. La descarga con `downloadMediaMessage` quedó dentro del adaptador Baileys. El núcleo de OCR/transcripción no conoce el SDK del cliente.

# Identidad y compatibilidad

Baileys conserva el JID actual como `conversationId` para no romper usuarios, sesiones, contextos y workdirs existentes. Un transporte futuro con otro espacio de IDs debe usar una identidad estable y preferentemente namespaced, por ejemplo `telegram:123456`, para evitar colisiones.

Los nombres internos heredados `jid` permanecen en varios gestores por compatibilidad, pero semánticamente representan el identificador estable de conversación entregado por el transporte.

# Archivos eliminados/reemplazados

- Se eliminó `src/tools/whatsapp-tools.ts`; su reemplazo es `src/tools/messaging-tools.ts`.
- Se eliminó `src/whatsapp-message-guard.ts`; el filtro de grupos específico de WhatsApp vive ahora en el adaptador/runner Baileys y `bot.ts` conserva una segunda barrera genérica mediante `message.isGroup`.

No se creó script Python de eliminación porque el usuario indicó explícitamente que reemplazará el proyecto completo con el ZIP entregado y pidió no generar dicho script para esta tarea.

# Pruebas añadidas/actualizadas

- El núcleo no puede importar Baileys ni sus tipos.
- La presencia `composing/paused` debe estar en el adaptador Baileys.
- Todo envío Baileys simula escritura.
- La cola conserva mensajes durante desconexiones.
- Archivos `image/*` pequeños se envían como medio nativo y PDF como documento.
- El filtro de grupos ocurre antes del núcleo y existe una segunda barrera genérica.
- `message_send` usa rutas seguras del workdir y `mode=auto`.

# Pendiente de validación en entorno del usuario

Ejecutar con Bun 1.3.14 y dependencias instaladas:

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
```

Pruebas manuales recomendadas:

1. Vincular Baileys y confirmar recepción/respuesta normal.
2. Verificar que cada respuesta muestre `escribiendo` antes de llegar.
3. Forzar una desconexión temporal y comprobar que la cola se vacíe al reconectar.
4. Pedir enviar una imagen del workdir y comprobar envío nativo.
5. Pedir enviar un PDF y comprobar envío como documento.
6. Pedir enviar una carpeta y comprobar ZIP.
7. Confirmar que mensajes de grupos continúen ignorándose.
8. Ejecutar `--transport=baileys` y el alias `--transport=whatsapp`.
