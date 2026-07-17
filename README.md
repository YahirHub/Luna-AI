<p align="center">
  <img src="assets/luna-ai.png" alt="Luna AI, gatita negra, gris y morada" width="420">
</p>

# Luna AI

Bot de WhatsApp en TypeScript y Bun con contexto persistente, memoria por usuario, recordatorios, alarmas recurrentes, búsqueda web multiproveedor, subagente investigador, selección de modelos y control de acceso.

## Funciones principales

- Vinculación de WhatsApp mediante código QR o número telefónico.
- Reconexión automática y sesión persistente.
- Conversación con contexto por usuario y compactación automática.
- Memoria duradera separada del historial conversacional.
- Recordatorios de una sola vez y alarmas recurrentes.
- Las alarmas entregadas se agregan al contexto persistente con fecha, texto configurado y respuesta enviada.
- OpenCode Free integrado como proveedor LLM predeterminado.
- Proveedor LLM personalizado opcional mediante `/setup-provider`.
- Búsqueda web con Tavily, Brave Search, Exa, Linkup, Firecrawl, SerpApi y Zenserp.
- Fallback automático entre motores configurados.
- Lectura segura de fuentes públicas mediante una herramienta interna.
- Subagente investigador aislado para consultas que requieren varias búsquedas o fuentes.
- Configuración del agente y de los motores desde WhatsApp, sin editar archivos manualmente.
- Administrador, usuarios, sesiones y bloqueo de cuentas.
- Persistencia atómica para archivos JSON críticos.
- Ejecución local, binaria o mediante Docker.

## Requisitos

- Bun 1.3.14 para desarrollo o compilación local.
- Una cuenta de WhatsApp para vincular el bot.
- Opcional: claves de uno o más motores de búsqueda.
- Opcional: un proveedor LLM compatible con la API de chat completions de OpenAI.

## Instalación local

```bash
git clone https://github.com/yahirhub/luna-ai.git
cd luna-ai
bun install
bun run start --qr
```

`bun install` debe generar `bun.lock`. Versiona el lockfile para que desarrollo, CI y Docker resuelvan las mismas dependencias.

## Primera configuración

No es necesario crear `.env` ni archivos JSON manualmente.

1. Inicia Luna y vincula WhatsApp.
2. Envía `!setup` para crear la primera cuenta administradora.
3. Inicia sesión con `!login`.
4. Conversa normalmente: Luna usa OpenCode Free de forma automática.
5. Configura búsqueda web con `/setup-search` cuando necesites acceso a internet.

## Proveedor LLM predeterminado

OpenCode Free se activa cuando no existe una configuración personalizada.

```text
Chat completions: https://opencode.ai/zen/v1/chat/completions
Modelos:          https://opencode.ai/zen/v1/models
```

Solo se aceptan IDs terminados en `-free`. Si el catálogo remoto falla, Luna usa una lista local de emergencia.

El modelo inicial para chats nuevos es `deepseek-v4-flash-free`. Los modelos desconocidos usan límites conservadores para reducir el riesgo de desbordar el contexto.

### Proveedor personalizado opcional

El administrador puede ejecutar:

```text
/setup-provider
```

El flujo solicita:

1. Endpoint completo de chat completions.
2. Endpoint completo del catálogo de modelos.
3. Modelo predeterminado.
4. API key, o `sin-clave`.

Al terminar se genera automáticamente:

```text
persistent/llm.config.json
```

La configuración se aplica en caliente y tiene prioridad en reinicios posteriores. Si falta o es inválida, Luna vuelve automáticamente a OpenCode Free.

Para restaurar el proveedor gratuito:

```text
/setup-provider gratis
```

Luna intenta eliminar del chat el mensaje que contiene la API key. Aun así, realiza la configuración únicamente en una conversación privada.

## Búsqueda web

La búsqueda no requiere modificar Docker ni crear archivos manualmente. El administrador abre:

```text
/setup-search
```

El menú permite:

- Guardar, reemplazar o eliminar la API key de cada motor.
- Activar o desactivar motores.
- Elegir el motor predeterminado.
- Definir el orden de fallback.
- Probar una conexión individual.
- Probar todos los motores activos.

Motores incluidos:

| Motor | Uso |
|---|---|
| Tavily | Resultados optimizados para agentes y contenido resumido. |
| Brave Search | Índice web independiente y contexto para LLM. |
| Exa | Búsqueda semántica y contenido de resultados. |
| Linkup | Búsqueda web estructurada. |
| Firecrawl | Búsqueda y extracción de contenido web. |
| SerpApi | Resultados orgánicos de buscadores. |
| Zenserp | Resultados orgánicos de buscadores. |

Las preferencias se guardan en:

```text
persistent/search.json
```

Las credenciales se guardan por separado en:

```text
persistent/search-auth.json
```

Ambos archivos permanecen dentro del volumen persistente y están excluidos de Git. Las API keys no se agregan al contexto, no se muestran completas y no se escriben en logs.

Si el motor predeterminado falla, Luna prueba los motores activos siguientes en el orden configurado. Si ninguno está disponible, explica que el administrador debe usar `/setup-search`.

## Herramientas internas y subagente investigador

Cuando la búsqueda está habilitada, Luna decide por sí misma cuándo utilizar:

- Búsqueda web: obtiene resultados normalizados con títulos, URLs, fragmentos y metadatos.
- Lectura de fuentes: consulta texto de una página pública para verificarla.
- Investigación delegada: crea un subagente aislado que busca y compara fuentes.

El subagente:

- Hereda el proveedor y modelo LLM seleccionados por el usuario.
- Trabaja con un contexto aislado; no recibe todo el chat principal.
- Prioriza documentación oficial y fuentes primarias.
- Puede realizar varias búsquedas y verificar páginas.
- Devuelve una síntesis breve con URLs completas.
- Tiene límite de rondas y timeout configurable.
- Usa una búsqueda directa como fallback si el gateway LLM ignora function calling.

La búsqueda no se expone como comando para los usuarios. Luna analiza cada mensaje y decide automáticamente si necesita una búsqueda rápida, leer una fuente o delegar la investigación al subagente. La consulta normal y la respuesta final quedan en el contexto persistente como cualquier conversación.

## `/config`

El administrador puede modificar el comportamiento del agente desde WhatsApp:

```text
/config
```

Opciones disponibles:

1. Activar o desactivar búsqueda web directa.
2. Activar o desactivar el subagente investigador.
3. Cambiar la profundidad predeterminada entre estándar y profunda.
4. Cambiar el timeout del investigador entre 60, 120, 180 y 300 segundos.

La configuración se guarda inmediatamente en:

```text
persistent/agent-config.json
```

La profundidad estándar solicita hasta 8 resultados por búsqueda. La profunda solicita hasta 15 y permite un flujo de investigación más amplio.

## Alarmas y contexto persistente

Cuando una alarma recurrente se entrega correctamente por WhatsApp, Luna agrega dos mensajes al contexto del usuario en una sola escritura:

1. Un evento automático con el texto de la alarma, el día programado y la fecha/hora real de entrega en `America/Mexico_City`.
2. El texto exacto que Luna envió al usuario.

Esto permite que preguntas posteriores como “¿qué alarma me enviaste hoy?” tengan contexto conversacional. Si WhatsApp confirma la entrega pero falla la escritura en disco, la alarma no se reenvía únicamente por ese fallo; el error se registra para diagnóstico.

## Ejecución

Inicio normal:

```bash
bun run start
```

Vinculación mediante QR:

```bash
bun run start --qr
```

Desarrollo con recarga:

```bash
bun run dev
```

Puede cambiarse la ubicación de la configuración LLM personalizada:

```bash
bun run start --llm-config ./persistent/proveedor-secundario.json
```

## Docker

El `Dockerfile` inicia el binario con `--qr`. Una instalación nueva muestra el código de vinculación en los logs del contenedor.

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

El volumen conserva la sesión de WhatsApp, usuarios, contextos, memoria, alarmas, configuración LLM, motores de búsqueda y credenciales. No es necesario montar archivos adicionales.

Para revisar el QR o los logs:

```bash
docker logs -f luna-ai
```

## Comandos del bot

Los prefijos `!` y `/` son aceptados por el parser. La tabla muestra el prefijo recomendado.

| Comando | Descripción |
|---|---|
| `!ayuda` | Muestra los comandos permitidos para la sesión. |
| `!ping` | Responde con `pong`. |
| `!id` | Muestra el JID de WhatsApp. |
| `/cancelar` | Cancela el flujo interactivo actual. |
| `!clear` | Reinicia la conversación sin borrar la memoria persistente. |
| `!modelos` | Actualiza el catálogo y permite seleccionar un modelo. |
| `!setup` | Crea la primera cuenta administradora. |
| `!login` | Inicia sesión. |
| `/setup-provider` | Configura un proveedor LLM personalizado; solo administrador. |
| `/setup-provider gratis` | Restaura OpenCode Free. |
| `/setup-search` | Configura motores, claves y fallback; solo administrador. |
| `/config` | Configura herramientas y subagente; solo administrador. |
| `!adduser` | Crea un usuario; solo administrador. |
| `!banuser` | Bloquea un usuario; solo administrador. |
| `!desban` | Desbloquea un usuario; solo administrador. |
| `!userlist` | Lista usuarios; solo administrador. |

## Persistencia

```text
persistent/
├── auth_info_baileys/       # Sesión de WhatsApp
├── contexts/<jid>/
│   ├── context.json         # Conversación, alarmas entregadas, modelo y compactación
│   ├── memory.md            # Memoria duradera del usuario
│   └── alarms.json          # Alarmas recurrentes
├── agent-config.json        # Configuración de herramientas y subagente
├── search.json              # Motores, estados, predeterminado y fallback
├── search-auth.json         # API keys de búsqueda; secreto
├── llm.config.json          # Solo si existe proveedor LLM personalizado
├── reminders.json           # Recordatorios de una sola vez
├── users.json               # Usuarios y sesiones del bot
└── uploads/                 # Imágenes recibidas
```

`persistent/` no debe versionarse ni exponerse públicamente.

## Seguridad de búsqueda

- `/setup-search` y `/config` requieren una sesión administradora.
- No existe un comando público para ejecutar búsquedas; las herramientas solo pueden ser llamadas por el agente.
- Las claves se almacenan separadas de las preferencias.
- Luna intenta borrar el mensaje entrante que contiene una clave.
- `read_url` solo acepta HTTP y HTTPS.
- Rechaza credenciales embebidas en URLs.
- Rechaza localhost, dominios internos y direcciones privadas o reservadas.
- Valida cada redirección antes de seguirla.
- Limita la descarga a 2 MB, la lectura a 50 000 caracteres y el tiempo a 20 segundos.
- Solo procesa contenido textual, HTML, JSON o XML.
- Las consultas enviadas a un motor externo están sujetas a la política de privacidad de ese proveedor.

## Estructura relevante

```text
assets/
└── luna-ai.png

src/
├── ai.ts                    # Chat completions, tools, timeout y catálogo LLM
├── agent-config.ts          # Configuración persistente y flujo /config
├── research-agent.ts        # Subagente investigador aislado
├── scheduled-context.ts     # Registro de alarmas entregadas en el contexto
├── search/
│   ├── read-url.ts          # Lectura de páginas con protecciones SSRF
│   ├── search-config.ts     # Tipos, proveedores y normalización
│   ├── search-runtime.ts    # Adaptadores y fallback multiproveedor
│   ├── search-setup.ts      # Flujo /setup-search
│   ├── search-storage.ts    # Preferencias y credenciales separadas
│   └── search-tools.ts      # Tool web_search
├── providers/
│   └── opencode-free.ts     # Proveedor LLM gratuito integrado
├── llm-config.ts            # Proveedor personalizado y /setup-provider
├── auth.ts                  # Usuarios, sesiones y permisos
├── bot.ts                   # Orquestación, comandos y ejecución de tools
├── context.ts               # Contexto persistente y compactación
├── scheduled-messages.ts    # Entrega de recordatorios y alarmas
├── storage.ts               # Persistencia atómica
├── memory.ts                # Memoria persistente
├── reminder.ts              # Recordatorios
├── alarm.ts                 # Alarmas recurrentes
└── index.ts                 # Entrada y vinculación
```

## Calidad y compilación

```bash
bun run typecheck
bun test
bun run build
```

El workflow de GitHub genera binarios para Linux amd64, Linux arm64 y Windows amd64. Ninguna credencial se incrusta en los binarios ni en los releases.

## Pruebas manuales importantes

1. Iniciar sin `persistent/llm.config.json` y confirmar que OpenCode Free esté activo.
2. Vincular WhatsApp, crear la cuenta administradora e iniciar sesión.
3. Crear una alarma próxima, esperar su entrega y comprobar que aparezca en `contexts/<jid>/context.json`.
4. Preguntar después por la alarma y verificar que el asistente recuerde el evento.
5. Abrir `/setup-search`, configurar un motor y probar la conexión.
6. Configurar dos motores, forzar el fallo del predeterminado y verificar el fallback.
7. Enviar una pregunta sobre información actual sin usar comandos y confirmar que Luna decida llamar `web_search` o `research_web`.
8. Confirmar que la respuesta incluya las fuentes necesarias sin exponer nombres de herramientas internas.
9. Intentar provocar la lectura de una URL privada o local y verificar que sea rechazada.
10. Desactivar búsqueda y subagente desde `/config` y comprobar que las herramientas desaparezcan.
11. Reiniciar el contenedor con el mismo volumen y verificar que toda la configuración persista.

## Limpieza segura en Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\limpiar-archivos-innecesarios.ps1 -WhatIf
powershell -ExecutionPolicy Bypass -File .\scripts\limpiar-archivos-innecesarios.ps1
```

El script no toca `persistent/`.
