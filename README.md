<p align="center">
  <img src="assets/luna-ai.png" alt="Luna AI, gatita negra y morada" width="420">
</p>

# Luna AI

Bot de WhatsApp en TypeScript y Bun con personalidad de gatita, contexto persistente, memoria por usuario, recordatorios, alarmas recurrentes, selección de modelos y control de acceso.

## Funciones principales

- Vinculación de WhatsApp mediante número telefónico o código QR.
- Reconexión automática y sesión persistente.
- Conversación con contexto y compactación automática.
- Memoria duradera separada por usuario.
- Recordatorios de una sola vez y alarmas recurrentes.
- Administrador, usuarios, sesiones y bloqueo de cuentas.
- OpenCode Free integrado y activo automáticamente sin configuración manual.
- Configuración opcional de un proveedor personalizado desde WhatsApp con `/setup-provider`.
- Catálogo remoto de modelos gratuitos con respaldo local si `/models` falla.
- Límites de contexto por coincidencia de modelo y fallback conservador para modelos desconocidos.
- Persistencia atómica para archivos JSON críticos.
- Ejecución local, binaria o mediante Docker.

## Requisitos

- Bun 1.3.14 para desarrollo o compilación local.
- Una cuenta de WhatsApp para vincular el bot.
- Opcional: un proveedor personalizado compatible con chat completions de OpenAI.

## Instalación local

```bash
git clone https://github.com/yahirhub/luna-ai.git
cd luna-ai
bun install
bun run start --qr
```

`bun install` debe generar `bun.lock`. Versiona ese lockfile para que desarrollo, CI y Docker resuelvan las mismas dependencias.

## Primera configuración

La primera ejecución no requiere crear archivos de configuración ni contratar un proveedor.

1. Inicia Luna y vincula WhatsApp.
2. Envía `!setup` al número vinculado para crear la primera cuenta administradora.
3. Inicia sesión y conversa normalmente: Luna usa **OpenCode Free** de forma automática.
4. Usa `!modelos` para consultar y seleccionar los modelos gratuitos disponibles.

El proveedor integrado consulta:

```text
Chat completions: https://opencode.ai/zen/v1/chat/completions
Modelos:          https://opencode.ai/zen/v1/models
```

Solo se aceptan IDs terminados en `-free`. Si el endpoint de modelos no responde, Luna conserva este catálogo local de emergencia:

```text
deepseek-v4-flash-free
mimo-v2.5-free
hy3-free
nemotron-3-ultra-free
north-mini-code-free
```

El modelo inicial para chats nuevos es `deepseek-v4-flash-free`. Los modelos desconocidos usan límites conservadores para evitar desbordar el contexto.

### Proveedor personalizado opcional

`/setup-provider` **no es obligatorio**. Solo se usa cuando el administrador quiere reemplazar OpenCode Free por otro proveedor.

Para volver posteriormente al proveedor integrado sin editar archivos:

```text
/setup-provider gratis
```

El flujo de proveedor personalizado solicita:

1. Endpoint completo de chat completions.
2. Endpoint completo del catálogo de modelos.
3. Modelo predeterminado.
4. API key, o `sin-clave` cuando no sea necesaria.

Al completar el flujo se genera:

```text
persistent/llm.config.json
```

La configuración personalizada se aplica en caliente y tiene prioridad en los siguientes reinicios. Si el archivo no existe o es inválido, Luna vuelve automáticamente a OpenCode Free.

En un proveedor personalizado, `!modelos` usa todos los IDs válidos devueltos por su endpoint, sin aplicar el filtro `-free`. Si ese catálogo falla, se mantiene el modelo predeterminado configurado.

Por seguridad, Luna intenta eliminar del chat el mensaje que contiene la API key. Realiza este flujo únicamente en una conversación privada.

## Ejecución

Inicio normal:

```bash
bun run start
```

Forzar vinculación mediante QR:

```bash
bun run start --qr
```

Desarrollo con recarga:

```bash
bun run dev
```

Opcionalmente puede cambiarse la ubicación donde `/setup-provider` guardará la configuración:

```bash
bun run start --llm-config ./persistent/proveedor-secundario.json
```

También se admite `--llm-config=./persistent/proveedor-secundario.json`.

## Docker

El `Dockerfile` inicia el binario con `--qr`, por lo que una instalación nueva muestra automáticamente el código de vinculación en los logs del contenedor.

### Linux o macOS

```bash
docker build -t luna-ai .
docker run --rm -it \
  --name luna-ai \
  -v luna-ai-data:/data/persistent \
  luna-ai
```

### PowerShell

```powershell
docker build -t luna-ai .
docker run --rm -it `
  --name luna-ai `
  -v luna-ai-data:/data/persistent `
  luna-ai
```

Después de vincular WhatsApp, crea el administrador con `!setup`. OpenCode Free funciona de inmediato; `/setup-provider` solo es necesario para sustituirlo por un proveedor personalizado. Cuando se usa, `persistent/llm.config.json` se guarda dentro del volumen `luna-ai-data`.

El entrypoint prepara los permisos como root y después ejecuta el bot con un usuario sin privilegios.

Para revisar el QR o los logs:

```bash
docker logs -f luna-ai
```

Para detenerlo cuando se ejecute sin `--rm`:

```bash
docker stop luna-ai
```

## Comandos del bot

Los prefijos `!` y `/` son aceptados por el parser. La documentación usa `/setup-provider` para distinguir el flujo de configuración administrativa.

| Comando | Descripción |
|---|---|
| `!ayuda` | Muestra los comandos permitidos para la sesión actual. |
| `!ping` | Responde con `pong`. |
| `!id` | Muestra el JID de WhatsApp. |
| `!cancelar` o `/cancelar` | Cancela el flujo interactivo actual. |
| `!clear` | Reinicia la conversación sin borrar la memoria persistente. |
| `!modelos` | Actualiza el catálogo y permite seleccionar un modelo. |
| `!setup` | Crea la primera cuenta administradora. |
| `!login` | Inicia sesión. |
| `/setup-provider` | Sustituye opcionalmente OpenCode Free por un proveedor personalizado; solo administrador. |
| `/setup-provider gratis` | Elimina el override personalizado y restaura OpenCode Free. |
| `!adduser` | Crea un usuario; solo administrador. |
| `!banuser` | Bloquea un usuario; solo administrador. |
| `!desban` | Desbloquea un usuario; solo administrador. |
| `!userlist` | Lista usuarios; solo administrador. |

## Persistencia

```text
persistent/
├── auth_info_baileys/       # Sesión de WhatsApp
├── contexts/<jid>/
│   ├── context.json         # Conversación, modelo y compactación
│   ├── memory.md            # Memoria duradera del usuario
│   └── alarms.json          # Alarmas recurrentes
├── llm.config.json          # Solo existe si se configura un proveedor personalizado
├── reminders.json           # Recordatorios de una sola vez
├── users.json               # Usuarios y sesiones del bot
└── uploads/                 # Imágenes recibidas
```

`persistent/` no debe versionarse ni exponerse públicamente. Contiene la sesión de WhatsApp, hashes de contraseña, conversaciones y, cuando se configura, la API key del proveedor personalizado.

## Estructura relevante

```text
assets/
└── luna-ai.png              # Mascota de Luna AI

src/
├── ai.ts                    # Solicitudes, tools, timeout y catálogo genérico
├── providers/
│   └── opencode-free.ts     # Endpoints, filtro, fallback y límites de modelos gratuitos
├── llm-config.ts            # Proveedor personalizado y flujo /setup-provider
├── auth.ts                  # Usuarios, sesiones y permisos
├── bot.ts                   # Orquestación, comandos y /setup-provider
├── commands.ts              # Parser y registro de comandos
├── connection.ts            # WhatsApp y reconexión
├── context.ts               # Contexto persistente y compactación
├── messaging.ts             # Envío con presencia de escritura
├── scheduled-messages.ts    # Entrega común de recordatorios y alarmas
├── storage.ts               # Persistencia atómica y rutas seguras
├── media.ts                 # Descarga y validación de imágenes
├── memory.ts                # Memoria persistente por usuario
├── reminder.ts              # Recordatorios de una sola vez
├── alarm.ts                 # Alarmas recurrentes
└── index.ts                 # Entrada, configuración y vinculación
```

## Calidad y compilación

```bash
bun run typecheck
bun test
bun run build
```

El workflow de GitHub genera binarios para Linux amd64, Linux arm64 y Windows amd64. La configuración LLM no se incrusta en los binarios ni en los releases.

## Pruebas manuales importantes

1. Iniciar sin `persistent/llm.config.json` y confirmar que el log indique `OpenCode Free`.
2. Vincular WhatsApp, crear la cuenta administradora con `!setup` e iniciar sesión.
3. Enviar un mensaje normal y confirmar que no solicite `/setup-provider`.
4. Ejecutar `!modelos` y comprobar que solo aparezcan IDs terminados en `-free`.
5. Interrumpir el endpoint de modelos y confirmar que aparezca el catálogo local de emergencia.
6. Seleccionar un modelo gratuito y comprobar que se conserve en el contexto del chat.
7. Ejecutar `/setup-provider`, cancelarlo y confirmar que OpenCode Free continúe funcionando.
8. Completar `/setup-provider` y confirmar que el proveedor personalizado se aplique sin reiniciar.
9. Reiniciar conservando el volumen y confirmar que el proveedor personalizado tenga prioridad.
10. Ejecutar `/setup-provider gratis` y confirmar que se elimine el override sin detener el bot.
11. Corromper temporalmente `llm.config.json` y comprobar que Luna vuelva a OpenCode Free.

## Limpieza segura en Windows

Para retirar archivos de configuración obsoletos de una copia anterior:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\eliminar-configuracion-obsoleta.ps1 -WhatIf
powershell -ExecutionPolicy Bypass -File .\scripts\eliminar-configuracion-obsoleta.ps1
```

La limpieza general elimina dependencias, builds, cobertura y temporales. No toca `persistent/`.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\limpiar-archivos-innecesarios.ps1 -WhatIf
powershell -ExecutionPolicy Bypass -File .\scripts\limpiar-archivos-innecesarios.ps1
```
