<p align="center">
  <img src="assets/luna-ai.png" alt="Luna AI, gatita negra, gris y morada" width="420">
</p>

# Luna AI

Bot de WhatsApp en TypeScript y Bun con contexto persistente, memoria por usuario, recordatorios, alarmas recurrentes, transcripción y OCR locales, búsqueda web multiproveedor, subagente investigador, selección de modelos y control de acceso.

## Funciones principales

- Vinculación de WhatsApp mediante código QR o número telefónico.
- Reconexión automática y sesión persistente.
- Conversación con contexto por usuario y compactación automática.
- Memoria duradera separada del historial conversacional; al crear un perfil nuevo Luna pregunta el nombre de forma simpática y lo guarda cuando se confirma.
- Recordatorios de una sola vez y alarmas recurrentes con mensaje de entrega persistido desde su creación. Cada creación válida genera una confirmación autoritativa del sistema; Luna no puede sustituirla con una afirmación inventada.
- Los recordatorios y alarmas entregados se agregan al contexto persistente con fecha, texto configurado y respuesta enviada.
- OpenCode Free integrado como proveedor LLM predeterminado.
- Proveedor LLM personalizado opcional mediante `/setup-provider`.
- Búsqueda web con Tavily, Brave Search, Exa, Linkup, Firecrawl, SerpApi y Zenserp.
- Fallback automático entre motores configurados.
- Lectura segura de fuentes públicas mediante una herramienta interna.
- Subagente investigador aislado para consultas que requieren varias búsquedas o fuentes.
- Configuración del agente y de los motores desde WhatsApp, sin editar archivos manualmente.
- Configuración global de Whisper desde `!setup-whisper` o mediante lenguaje natural para administradores, con catálogo oficial, descarga de modelos y parámetros persistentes.
- Transcripción local de notas de voz OGG/Opus mediante el ejecutable oficial `whisper-cli` de whisper.cpp.
- OCR local de imágenes JPEG/PNG en español mediante Tesseract WASM.
- Luna compila como binario standalone y se distribuye junto al runtime oficial de whisper.cpp; sin FFmpeg, Python ni APIs multimedia.
- Administrador, usuarios, sesiones y bloqueo de cuentas, también gestionables por lenguaje natural con herramientas restringidas a administradores.
- Persistencia atómica para archivos JSON críticos.
- Ejecución local, binaria o mediante Docker.

## Requisitos

- Bun 1.3.14 para desarrollo o compilación local.
- Una cuenta de WhatsApp para vincular el bot.
- Opcional: claves de uno o más motores de búsqueda.
- Opcional: un proveedor LLM compatible con la API de chat completions de OpenAI.
- Conexión a internet durante `bun run dev` o `bun run build` para consultar la release `latest` de whisper.cpp, descargar el binario correcto para el sistema y verificar su SHA-256. Después funciona offline.

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
6. Opcionalmente ajusta el modelo de transcripción con `!setup-whisper`.

## Procesamiento multimedia local

Luna procesa localmente las notas de voz y el texto de imágenes. El bot principal es un ejecutable Bun standalone; la transcripción se delega al `whisper-cli` oficial distribuido junto a Luna y el OCR continúa dentro del subproceso multimedia. No se envían archivos a APIs de transcripción u OCR.

### Notas de voz

- Formatos aceptados: `audio/ogg` y `audio/opus`, incluidos los mensajes OGG/Opus habituales de WhatsApp.
- Límite de archivo: 12 MB. La duración máxima predeterminada es 120 segundos y puede cambiarse globalmente.
- El decoder OGG/Opus convierte la nota a WAV PCM mono de 16 kHz sin FFmpeg. Después Luna invoca el `whisper-cli` oficial con el modelo multilingüe cuantizado `base-q5_1` incluido por defecto.
- El administrador puede usar `!setup-whisper` para descargar otro modelo oficial, activarlo globalmente y ajustar idioma, traducción, hilos, best-of, beam size, temperatura, umbral sin voz, duración máxima y timeout.
- Los modelos descargados se guardan en `persistent/whisper/models/`, por lo que sobreviven reinicios y actualizaciones del contenedor.
- El audio se mezcla a mono y se reduce de 48 kHz a 16 kHz antes de transcribir.
- WhatsApp muestra únicamente `🎙️ Transcribiendo audio...`; al terminar, la transcripción se entrega al asistente marcada como texto generado por el sistema.


### Configuración global de Whisper

El comando administrativo:

```text
!setup-whisper
```

permite consultar el modelo activo y cambiar los parámetros sin editar archivos ni recompilar. El menú lista los modelos oficiales publicados para whisper.cpp, incluidos Tiny, Base, Small, Medium, Large y Large Turbo, junto con sus variantes cuantizadas, variantes en inglés y tamaño aproximado.

El modelo `base-q5_1` ya viene incluido en los builds y releases. Cuando se elige otro modelo, Luna solicita confirmación, consulta los metadatos oficiales de Hugging Face, descarga el archivo con reanudación, comprueba espacio libre y verifica su SHA-256 antes de activarlo. La configuración global se guarda en:

```text
persistent/whisper.json
```

Los modelos adicionales se almacenan en:

```text
persistent/whisper/models/
```

Parámetros configurables:

- Modelo global.
- Idioma fijo, detección automática o código ISO personalizado.
- Traducción al inglés.
- Hilos de CPU o selección automática.
- `best-of`.
- `beam size`.
- Temperatura.
- Umbral de ausencia de voz.
- Duración máxima aceptada.
- Timeout de transcripción.
- Limpieza de modelos descargados que no estén activos.

Los modelos con `.en` solo admiten inglés. Al seleccionarlos, Luna fija automáticamente el idioma en `en`. Los cambios se aplican al siguiente audio y no requieren reiniciar el bot.

Un administrador también puede pedir en lenguaje natural acciones como “muéstrame la configuración de Whisper”, “cambia el idioma a automático”, “usa 8 hilos” o “qué modelos puedo descargar”. Luna dispone de herramientas administrativas para consultar el estado, listar modelos con su peso, modificar parámetros, descargar y activar modelos con confirmación explícita y limpiar modelos inactivos. Estas herramientas no se exponen a usuarios normales.

Las transcripciones se marcan como texto generado por el sistema. El prompt de Luna le ordena no ejecutar recordatorios, alarmas, cambios de memoria u otras acciones cuando una transcripción sea ambigua, incompleta o parezca mal reconocida; primero debe explicar lo entendido y pedir confirmación.

### Imágenes

- Formatos aceptados: JPEG y PNG.
- Límite: 10 MB, 16 megapíxeles y 20 000 caracteres extraídos.
- Tesseract WASM y el modelo rápido de español se incorporan al binario.
- El texto extraído y el pie de imagen se entregan al asistente con marcadores que conservan su origen.

El procesamiento pesado corre en un subproceso persistente y serializado para no bloquear la conexión de WhatsApp. El subproceso ejecuta `whisper-cli` para audio y Tesseract WASM para OCR. Luna mantiene el estado `escribiendo` durante el trabajo y admite como máximo tres solicitudes pendientes para evitar saturar memoria.

Durante `bun run dev` y `bun run build`, `scripts/prepare-media-assets.ts` consulta la API oficial de GitHub, selecciona la release `latest` de whisper.cpp para Windows x64, Linux x64 o Linux arm64, verifica el digest SHA-256 publicado por GitHub y extrae todo el paquete oficial. También descarga y verifica el modelo Whisper y prepara los recursos OCR. `assets/runtime/` es temporal y no se versiona.

`bun run build` copia a `dist/runtime/whisper/` el ejecutable, las DLL o bibliotecas compartidas, el manifiesto de versión y el modelo. Para mover Luna manualmente debes copiar el ejecutable **junto con la carpeta `runtime/`**. Los paquetes de GitHub Releases ya vienen completos y listos para ejecutar.

En Linux, la preparación restaura como archivos regulares los nombres SONAME que suelen distribuirse como enlaces simbólicos, por ejemplo `libwhisper.so.1`. También copia `libgomp.so.1`, requerido por OpenMP, dentro de `runtime/whisper/system-libs`, por lo que los paquetes Linux no dependen de que el servidor tenga instalado `libgomp1`. Luna primero busca la biblioteca en el sistema; si no existe, intenta obtener el paquete con `apt-get download` sin instalarlo y, si los índices APT no están disponibles, usa un paquete oficial de Debian Bookworm fijado por arquitectura y SHA-256 para amd64 o ARM64. Antes de aceptar un runtime Linux, el build ejecuta `whisper-cli --help` con su `LD_LIBRARY_PATH`; si falta una biblioteca, el build falla en lugar de publicar un release roto. Durante la transcripción, Luna vuelve a agregar automáticamente todas las carpetas de bibliotecas del runtime a `PATH` y `LD_LIBRARY_PATH`.

Si una descarga automática está bloqueada, puedes descargar manualmente el asset oficial de la release más reciente y señalarlo sin desactivar la verificación:

```powershell
$env:WHISPER_CPP_ARCHIVE_PATH = "C:\Descargas\whisper-bin-x64.zip"
$env:WHISPER_MODEL_PATH = "C:\Descargas\ggml-base-q5_1.bin"
bun run build
```

El archivo manual debe coincidir con el digest publicado por GitHub y el modelo debe coincidir con su SHA-256 esperado.

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

## Subagente investigador

Cuando una consulta necesita información actual o verificación externa, el modelo principal solo puede llamar a `research_web`. Esa herramienta crea un investigador independiente con su propio contexto temporal.

Dentro de ese contexto aislado, el subagente puede:

- Buscar con `web_search` usando el motor configurado y sus respaldos.
- Leer páginas públicas con `read_url` para verificar las fuentes relevantes.
- Ejecutar varias rondas de búsqueda y comparación.
- Priorizar documentación oficial y fuentes primarias.
- Devolver al bot principal únicamente la síntesis final y las URLs utilizadas.

Los resultados completos, páginas leídas y mensajes intermedios del investigador no se agregan al historial principal. Así se evita saturar el contexto persistente del usuario con evidencia temporal.

El modelo principal no recibe `web_search` ni `read_url` directamente. Toda búsqueda pasa obligatoriamente por el subagente. Si el gateway LLM ignora function calling dentro del investigador, el fallback de búsqueda continúa ejecutándose dentro de ese mismo contexto aislado.

La búsqueda tampoco se expone como comando para los usuarios. Luna analiza cada mensaje y decide automáticamente cuándo necesita investigar.

### Progreso visible en WhatsApp

Mientras investiga, Luna mantiene activo el estado `escribiendo` sin añadir una espera artificial y envía avances reales como:

```text
🕵️ AGENTE INVESTIGADOR

Buscando: “Versiones actuales de Laravel”
Profundidad: estándar
```

Después muestra un resumen de resultados con títulos y URLs, informa qué fuentes está verificando y avisa cuando está comparando la evidencia. Al terminar, la respuesta final se envía inmediatamente, sin simular otros 3 a 5 segundos de escritura.

Si el investigador alcanza su timeout después de obtener resultados, no descarta el trabajo realizado. Devuelve una respuesta parcial con títulos, fragmentos, URLs y las fuentes que sí alcanzó a abrir, marcada claramente como investigación incompleta. Solo devuelve un error de timeout cuando no consiguió ninguna evidencia utilizable.

## `/config`

El administrador puede modificar el comportamiento del agente desde WhatsApp:

```text
/config
```

Opciones disponibles:

1. Activar o desactivar el acceso web del investigador.
2. Activar o desactivar el subagente investigador.
3. Cambiar la profundidad predeterminada entre estándar y profunda.
4. Cambiar el timeout del investigador entre 60, 120, 180 y 300 segundos.

La configuración se guarda inmediatamente en:

```text
persistent/agent-config.json
```

La profundidad estándar solicita hasta 8 resultados por búsqueda. La profunda solicita hasta 15 y permite un flujo de investigación más amplio.

## Recordatorios, alarmas y contexto persistente

La única prueba de que una creación ocurrió es el resultado exitoso de `create_reminder` o `create_alarm`. Después de persistir la acción, Luna envía un mensaje separado con el encabezado `⚙️ CONFIRMACIÓN DEL SISTEMA` y guarda en `context.json` un evento `[Resultado de herramienta confirmado por el sistema]`. Las frases anteriores del asistente no cuentan como evidencia.

Si el usuario cuestiona una creación anterior, Luna debe consultar `list_reminders` o `list_alarms` antes de crear otra, evitando duplicados. Además, una negación explícita como “no crees ningún recordatorio” bloquea determinísticamente la herramienta aunque el modelo intente llamarla. Si la respuesta final afirma una creación sin confirmación del tipo correcto, el sistema suprime esa afirmación y devuelve únicamente un estado autoritativo de acción no confirmada.

Al crear un recordatorio o una alarma, Luna guarda un `deliveryMessage` autocontenido con su personalidad. El modelo que ejecuta `create_reminder` o `create_alarm` puede prepararlo en ese momento; si no lo hace, Luna genera localmente un mensaje seguro. Este texto queda dentro del sandbox del usuario, en `persistent/contexts/<jid>/reminders.json` o `alarms.json`, y no depende de que el proveedor LLM continúe disponible cuando llegue la hora.

Al dispararse una notificación:

1. Si existe modelo y proveedor, Luna recibe el mensaje persistido y puede usarlo tal cual o reformularlo sin cambiar la acción ni los datos importantes.
2. Si el proveedor falla, no existe modelo o la respuesta está vacía o solo repite el título, se envía el mensaje persistido.
3. WhatsApp nunca recibe únicamente `⏰ RECORDATORIO` o un cuerpo vacío.
4. Después de una entrega confirmada se agregan al contexto el evento automático y el texto exacto enviado.

Esto permite preguntas posteriores como “¿qué recordatorio me enviaste hoy?” o “¿qué alarma sonó?” con contexto conversacional. Luna no lee ni migra el antiguo archivo global `persistent/reminders.json`; durante las pruebas locales puede eliminarse manualmente.

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

El volumen conserva la sesión de WhatsApp, usuarios, contextos, memoria, alarmas, configuración LLM, motores de búsqueda, credenciales y la configuración global de Whisper. Los modelos Whisper descargados por `!setup-whisper` también permanecen en el volumen. Los audios e imágenes originales se procesan temporalmente y no se conservan. No es necesario montar archivos adicionales.

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
| `!setup-whisper` | Configura el modelo y parámetros globales de transcripción; solo administrador. |
| `!adduser` | Crea un usuario; solo administrador. |
| `!banuser` | Bloquea un usuario; solo administrador. |
| `!desban` | Desbloquea un usuario; solo administrador. |
| `!userlist` | Lista usuarios; solo administrador. |

Los administradores pueden realizar las mismas operaciones de usuarios con lenguaje natural: listar cuentas, iniciar de forma segura la creación de un usuario, bloquearlo o desbloquearlo. La contraseña nunca se pasa como argumento al modelo; después de iniciar la creación, el bot la solicita en un mensaje separado, la procesa fuera del chat LLM e intenta borrar el mensaje de WhatsApp.

## Persistencia

```text
persistent/
├── auth_info_baileys/       # Sesión de WhatsApp
├── contexts/<jid>/
│   ├── context.json         # Conversación, alarmas entregadas, modelo y compactación
│   ├── memory.md            # Memoria duradera del usuario
│   ├── reminders.json       # Recordatorios de una sola vez
│   └── alarms.json          # Alarmas recurrentes
├── agent-config.json        # Configuración de herramientas y subagente
├── search.json              # Motores, estados, predeterminado y fallback
├── search-auth.json         # API keys de búsqueda; secreto
├── llm.config.json          # Solo si existe proveedor LLM personalizado
├── whisper.json             # Modelo y parámetros globales de transcripción
├── whisper/models/          # Modelos adicionales descargados por el administrador
└── users.json               # Usuarios y sesiones del bot
```

`persistent/` no debe versionarse ni exponerse públicamente.

## Seguridad de búsqueda

- `/setup-search` y `/config` requieren una sesión administradora.
- No existe un comando público para ejecutar búsquedas; el modelo principal solo puede delegarlas al subagente investigador.
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
├── luna-ai.png
└── runtime/                 # whisper.cpp, modelo y WASM OCR preparados; ignorados por Git

patches/
└── ogg-opus-decoder@1.7.3.patch # Evita incluir su WebWorker opcional en Bun compile

scripts/
├── prepare-media-assets.ts  # Descarga latest, repara y valida whisper.cpp
├── package-runtime.ts       # Copia whisper.cpp y restaura aliases Linux
├── whisper-linux-libs.ts    # Preserva SONAME e incluye libgomp.so.1
└── eliminar-whisper-wasm-obsoleto.ps1 # Limpieza segura de la implementación sustituida

src/
├── ai.ts                    # Chat completions, tools, timeout y catálogo LLM
├── agent-config.ts          # Configuración persistente y flujo /config
├── research-agent.ts        # Subagente aislado, progreso, evidencia parcial y timeout
├── scheduled-context.ts     # Registro de recordatorios y alarmas entregados
├── media.ts                 # Validación y descarga en memoria de audio/imágenes
├── whisper-config.ts        # Catálogo, persistencia y descarga segura de modelos
├── whisper-setup.ts         # Flujo administrativo !setup-whisper
├── media-processing/
│   ├── audio-utils.ts       # Mezcla mono y reducción a 16 kHz
│   ├── client.ts            # Cola e IPC con el subproceso multimedia
│   ├── protocol.ts          # Contrato de mensajes
│   ├── whisper-native.ts    # WAV, resolución del runtime y ejecución de whisper-cli
│   └── worker.ts            # OGG/Opus, whisper.cpp y OCR WASM
├── search/
│   ├── read-url.ts          # Lectura de páginas con protecciones SSRF
│   ├── search-config.ts     # Tipos, proveedores y normalización
│   ├── search-runtime.ts    # Adaptadores y fallback multiproveedor
│   ├── search-setup.ts      # Flujo /setup-search
│   ├── search-storage.ts    # Preferencias y credenciales separadas
│   └── search-tools.ts      # web_search, uso exclusivo del subagente
├── providers/
│   └── opencode-free.ts     # Proveedor LLM gratuito integrado
├── llm-config.ts            # Proveedor personalizado y /setup-provider
├── auth.ts                  # Usuarios, sesiones y permisos
├── admin-tools.ts           # Whisper y usuarios por lenguaje natural, solo admin
├── tool-confirmation.ts     # Confirmación autoritativa y bloqueo de falsos positivos
├── bot.ts                   # Orquestación, comandos, permisos y ejecución confirmada de tools
├── context.ts               # Contexto persistente, reglas de veracidad y compactación
├── scheduled-copy.ts        # Mensajes persistidos y fallback local de Luna
├── scheduled-messages.ts    # Entrega robusta de recordatorios y alarmas
├── storage.ts               # Persistencia atómica
├── memory.ts                # Memoria persistente y perfil inicial simpático
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

Salida local esperada:

```text
dist/
├── luna-ai.exe              # Windows; en Linux se llama luna-ai
└── runtime/
    └── whisper/             # whisper-cli, bibliotecas, modelo y manifest.json
```

El workflow de GitHub genera paquetes para Linux amd64, Linux arm64 y Windows amd64. Cada paquete contiene el ejecutable de Luna, la release `latest` de whisper.cpp correspondiente a la plataforma, sus DLL o bibliotecas compartidas, el modelo Whisper y el README. Los paquetes Linux incluyen además `libgomp.so.1`, requerido por OpenMP, y el workflow comprueba su presencia antes de comprimir el release. OCR permanece embebido en Luna. No requiere Bun, Node, FFmpeg, Python ni Tesseract instalados. Ninguna credencial se incrusta en los releases.

## Pruebas manuales importantes

1. Iniciar sin `persistent/llm.config.json` y confirmar que OpenCode Free esté activo.
2. Vincular WhatsApp, crear la cuenta administradora e iniciar sesión.
3. Crear una alarma próxima, esperar su entrega y comprobar que aparezca en `contexts/<jid>/context.json`.
4. Preguntar después por la alarma y verificar que el asistente recuerde el evento.
5. Abrir `/setup-search`, configurar un motor y probar la conexión.
6. Configurar dos motores, forzar el fallo del predeterminado y verificar el fallback.
7. Enviar una pregunta sobre información actual sin usar comandos y confirmar que el modelo principal llame únicamente `research_web`.
8. Verificar que aparezcan el estado `escribiendo`, la consulta del agente, los resultados encontrados y las fuentes que está revisando.
9. Confirmar que la respuesta final se envíe sin una espera artificial después de terminar la investigación.
10. Revisar `context.json` y comprobar que no contenga resultados completos ni páginas leídas por el subagente.
11. Intentar provocar la lectura de una URL privada o local y verificar que sea rechazada.
12. Desactivar búsqueda y subagente desde `/config` y comprobar que `research_web` desaparezca.
13. Abrir `!setup-whisper`, comprobar el catálogo, cambiar un parámetro y verificar `persistent/whisper.json`.
14. Descargar un modelo alternativo pequeño, activarlo y comprobar que se conserve después de reiniciar.
15. Enviar una nota de voz OGG/Opus en español, verificar el progreso, la transcripción y que Luna responda al contenido.
16. Enviar una imagen JPEG o PNG con texto, verificar el OCR y que el pie de imagen también llegue al asistente.
17. Probar un audio mayor que la duración configurada y una imagen mayor de 10 MB para confirmar que se rechacen antes de procesarlos.
18. Reiniciar el contenedor con el mismo volumen y verificar que toda la configuración persista.

## Limpieza segura en Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\limpiar-archivos-innecesarios.ps1 -WhatIf
powershell -ExecutionPolicy Bypass -File .\scripts\limpiar-archivos-innecesarios.ps1
```

El script no toca `persistent/`.
