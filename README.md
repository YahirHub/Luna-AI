# Luna AI

Bot de WhatsApp en TypeScript usando Bun y `@whiskeysockets/baileys`, con una asistente virtual llamada **Luna**.

Luna puede conversar con contexto persistente, recordar información importante por usuario, crear recordatorios y administrar acceso básico por cuentas.

## Características

- Vinculación de WhatsApp por **número de teléfono** o **código QR**
- Conversación con **contexto persistente por usuario**
- **Memoria persistente** para guardar datos importantes
- **Recordatorios** con creación, listado y eliminación
- **Autenticación básica** con administrador y usuarios
- Descarga y guardado de imágenes recibidas
- Selección de modelos AI disponibles desde el chat

## Requisitos

- [Bun](https://bun.sh) ≥ 1.0
- Node.js ≥ 20

## Instalación

```bash
git clone https://github.com/yahirhub/luna-ai.git
cd luna-ai
bun install
```

## Configuración

Este proyecto **ya no usa archivo `.env` para el número de WhatsApp**.

Si tu proveedor de AI requiere autenticación, define la variable de entorno `AI_API_KEY` antes de iniciar el bot.

## Ejecución

```bash
# Producción
bun run start

# Desarrollo
bun run dev
```

Si no existe una sesión guardada, el bot mostrará un menú para elegir el método de vinculación:

1. **Número de teléfono**
2. **Código QR**

También puedes forzar el modo QR con:

```bash
bun run start --qr
```

## Comandos disponibles

| Comando | Descripción |
|---|---|
| `!ayuda` | Muestra todos los comandos disponibles |
| `!ping` | Responde con `pong` |
| `!id` | Muestra tu JID de WhatsApp |
| `!cancelar` | Cancela la operación actual |
| `!clear` | Reinicia la conversación |
| `!modelos` | Lista y permite seleccionar modelos disponibles |
| `!setup` | Crea la primera cuenta de administrador |
| `!login` | Inicia sesión |
| `!adduser` | Crea un nuevo usuario (solo admin) |
| `!banuser` | Banea un usuario (solo admin) |
| `!desban` | Desbanea un usuario (solo admin) |
| `!userlist` | Lista usuarios registrados (solo admin) |

## Estructura del proyecto

```text
.
├── src/
│   ├── ai.ts          # Integración con modelos AI y tools
│   ├── auth.ts        # Usuarios, login, sesiones y permisos
│   ├── bot.ts         # Procesamiento de mensajes y comandos
│   ├── commands.ts    # Registro, parser y dispatch de comandos
│   ├── connection.ts  # Conexión y reconexión de WhatsApp
│   ├── context.ts     # Contexto persistente por usuario
│   ├── index.ts       # Punto de entrada y menú de arranque
│   ├── media.ts       # Descarga y validación de imágenes
│   ├── memory.ts      # Memoria persistente del bot
│   ├── reminder.ts    # Recordatorios y scheduler
│   └── utils.ts       # Utilidades generales
├── __tests__/         # Pruebas unitarias
├── contexto/          # Bitácora técnica persistente del proyecto
├── Dockerfile
├── entrypoint.sh
├── package.json
├── tsconfig.json
└── README.md
```

## Pruebas

```bash
bun test
```

## Typecheck

```bash
bun run typecheck
```

## Notas

- Las credenciales de WhatsApp se persisten en disco para reconexión automática.
- La conversación y la memoria se guardan por usuario.
- Los recordatorios usan la hora de Ciudad de México.
- Las imágenes recibidas se guardan localmente con validación.
- No se imprimen claves ni credenciales sensibles en los logs.
