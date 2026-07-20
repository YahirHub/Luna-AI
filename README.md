<p align="center">
  <img src="assets/luna-ai.png" alt="Luna AI, gatita negra, gris y morada" width="420">
</p>

# Luna AI

Bot de WhatsApp en TypeScript y Bun con contexto persistente, memoria por usuario, recordatorios, alarmas recurrentes, transcripción y OCR locales, búsqueda web multiproveedor, subagentes de investigación y navegación interactiva, selección de modelos y control de acceso.

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
- Subagente `browser-web` basado en `agent-browser` para navegación interactiva, sesiones autenticadas, extracción de paneles, capturas y descargas sin requerir modelos con visión.
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
- Conexión a internet durante la primera preparación cuando falten runtimes. `bun install`, `bun run dev`, `bun run start` y `bun run build` preparan automáticamente `agent-browser`; `bun run dev` y `bun run build` también preparan los assets multimedia cuando corresponde. Después, los componentes ya descargados se reutilizan.

## Instalación local

```bash
git clone https://github.com/yahirhub/luna-ai.git
cd luna-ai
bun install
bun run start --qr
```

`bun install` debe generar `bun.lock`. Versiona el lockfile para que desarrollo, CI y Docker resuelvan las mismas dependencias. El `postinstall` del proyecto ejecuta automáticamente `prepare:browser`: prepara el binario nativo exacto de la plataforma/arquitectura y guarda un manifest para no reutilizar por accidente un runtime de otra arquitectura. En Windows x64, Linux x64 y macOS puede reutilizar Chrome for Testing; en Linux ARM64 usa Chromium/Chrome del sistema porque Google no publica Chrome for Testing para esa plataforma. No es necesario ejecutar manualmente `bunx agent-browser install`.

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

En Linux, la preparación restaura como archivos regulares los nombres SONAME que suelen distribuirse como enlaces simbólicos, por ejemplo `libwhisper.so.1`. También incluye `libgomp.so.1`, requerido por OpenMP, dentro de `runtime/whisper/system-libs`. Para evitar incompatibilidades entre la glibc del host de build y la del servidor final, el camino normal ya no copia `libgomp` directamente desde el sistema de build: usa un paquete oficial Debian Bookworm fijado por arquitectura y SHA-256 para amd64 o ARM64 y registra `portable-runtime-dependencies.json`. Un runtime antiguo conservado en `assets/` sin ese manifest se repara automáticamente. APT queda solo como fallback. Antes de aceptar un runtime Linux, el build ejecuta `whisper-cli --help` con su `LD_LIBRARY_PATH`; si falta una biblioteca, el build falla en lugar de publicar un release roto. Durante la transcripción, Luna vuelve a agregar automáticamente todas las carpetas de bibliotecas del runtime a `PATH` y `LD_LIBRARY_PATH`.

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

Luna intenta eliminar del chat el mensaje que contiene la API key. Aun así, realiza la configuración únicamente en una conversación privada. El administrador también puede decir “configura un proveedor personalizado” para iniciar el mismo flujo seguro o “vuelve a OpenCode Free” para restaurar el proveedor integrado.

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

Si el motor predeterminado falla, Luna prueba los motores activos siguientes en el orden configurado. Si ninguno está disponible, explica que el administrador debe usar `/setup-search`. El administrador puede realizar las mismas operaciones mediante lenguaje natural: consultar estados, activar o desactivar motores, cambiar el predeterminado, reordenar el fallback, probar proveedores, eliminar una clave o iniciar la captura segura de una nueva API key.

## Runtime agéntico y subagentes

Luna usa un runtime de subagentes inspirado en el patrón probado de Codewolf, pero integrado directamente en el proyecto y sin MCP. El agente principal conserva el control del flujo: delega investigaciones, recibe únicamente las respuestas finales de los especialistas y después decide si necesita investigar algo más, sintetizar, crear archivos o enviar resultados.

El agente disponible inicialmente es `researcher-web`. Tiene:

- Contexto aislado y sin historial del agente padre.
- Solo las herramientas `web_search` y `read_url`.
- Un loop propio de modelo → herramienta → modelo, con hasta 64 pasos como protección contra loops.
- Timeout de seguridad independiente de 15 minutos por defecto; no es un objetivo de duración.
- Instrucciones para construir una checklist privada de evidencia, priorizar fuentes oficiales, abrir las páginas antes de concluir, evitar búsquedas duplicadas y marcar explícitamente lo no resuelto.
- Salida `last_message`: el agente principal recibe únicamente la síntesis final, no las páginas completas ni todo el historial intermedio.

El modelo principal no recibe `web_search` ni `read_url` directamente. Para una investigación individual usa `researcher_web`; para dos o más investigaciones independientes usa `spawn_agents`.

También existe `browser-web`, especializado en navegación interactiva mediante `agent-browser`. El agente trabaja sin visión: interpreta snapshots del árbol de accesibilidad y texto renderizado, navega con referencias `@eN`, puede iniciar sesión mediante una referencia de credencial segura, extraer métricas, tomar capturas y descargar archivos. El agente principal usa `browser_agent` para una tarea de navegador individual o `spawn_agents` con `agent_type=browser-web` cuando conviene combinar navegación con otros trabajos paralelos.

Ejemplo:

```text
Inicia sesión en domain.tld con el usuario user123 y la contraseña patito123, navega al panel, extrae las métricas y dame un PDF.
```

La contraseña incluida explícitamente en el mensaje se intercepta antes de llegar al LLM y se sustituye por una `credential_ref` opaca, pero este preprocesamiento de seguridad no decide ni ejecuta herramientas. La presencia de una URL, `localhost`, un correo o una credencial segura nunca abre el navegador automáticamente: el agente principal conserva la responsabilidad de decidir entre `browser_agent`, `researcher_web`, `spawn_agents` o ninguna herramienta.

Las credenciales de sitios web se administran por usuario de Luna y pueden existir varias cuentas para el mismo dominio. `browser_credentials_save`, `browser_credentials_list` y `browser_credentials_delete` permiten configurar, consultar y eliminar perfiles desde lenguaje natural sin exponer contraseñas al LLM. La contraseña queda cifrada en `persistent/browser/credential-profiles.json` mediante AES-256-GCM usando la clave local `persistent/browser/encryption.key`; el índice puede contener URL, correo/usuario y referencias opacas, pero nunca la contraseña en texto plano.
La clave de cifrado es compartida por el almacén de credenciales y el runtime de `agent-browser`. Si el archivo ya existe pero no contiene una clave válida de 256 bits, Luna falla de forma explícita y **no lo regenera automáticamente**, evitando invalidar silenciosamente credenciales cifradas con una clave anterior. El índice de perfiles se actualiza mediante escritura atómica para reducir el riesgo de corrupción ante una interrupción.

Cuando `browser-web` llega a una pantalla de login, primero puede consultar `browser_auth_profiles`. Si encuentra una cuenta compatible, `browser_auth_login` descifra la contraseña únicamente dentro del runtime, la entrega temporalmente a `agent-browser` por `stdin`, inicia sesión y vuelve a eliminar el perfil temporal del vault interno del CLI. Si la sesión web caduca, el agente puede repetir el login con el perfil cifrado sin volver a pedir la contraseña. Si la contraseña real cambió o dejó de ser válida, el agente solicita una nueva mediante `browser_request_user_input`; después de un login correcto la credencial cifrada de URL + usuario se reemplaza sin crear duplicados.

Si durante la navegación falta información humana, `browser-web` dispone de `browser_request_user_input`. El sistema puede solicitar `username`, `password`, `otp` o texto adicional y reanudar la solicitud original cuando el usuario responda. Los valores no secretos pueden volver al contexto como datos de sistema; las contraseñas y OTP se capturan fuera del modelo. Las contraseñas se convierten en una `credential_ref` y los secretos de un solo uso en una `secret_ref`, que solo puede consumir `browser_fill_secret`. Los mensajes de contraseña/OTP se intentan borrar de WhatsApp después de capturarlos.

Si el orquestador principal sabe desde el inicio que falta una contraseña, todavía puede llamar `browser_request_credential`; solo entonces Luna envía un mensaje marcado como `MENSAJE DEL SISTEMA`, indicando que por seguridad el agente no debe conocer la contraseña. El siguiente mensaje se captura fuera del modelo y la tarea se reanuda automáticamente.

`browser-web` conserva archivos físicos por tarea:

```text
persistent/contexts/<jid>/workdir/tasks/<task-id>/agents/01-browser-web/
├── request.json
├── events.jsonl
├── result.json
├── result.md
└── browser/
    ├── snapshots/
    ├── extracted/
    ├── screenshots/
    └── downloads/
```

Las capturas y descargas se registran como artefactos del workdir. Si el usuario pide una captura, el agente de navegador crea el PNG y el agente principal lo envía con `whatsapp_send`. Si pide un informe, el agente principal recibe la síntesis y las rutas de artefactos, crea el Markdown/PDF y después lo envía. El contenido de páginas se trata como no confiable y `agent-browser` se ejecuta con content boundaries y límite de salida.

La preparación de `agent-browser` es automática. `bun install` ejecuta `prepare:browser` mediante `postinstall`, y `bun run start`, `bun run dev` y `bun run build` vuelven a ejecutar esa preparación de forma idempotente. El script usa primero el binario nativo instalado en `node_modules`; si Bun no ejecutó el lifecycle del paquete, intenta el `postinstall` oficial y, como último fallback, descarga el binario exacto de la release configurada. `assets/runtime/agent-browser/manifest.json` registra versión, plataforma y arquitectura para impedir que un binario x64 conservado se reutilice en ARM64 o viceversa. `scripts/package-runtime.ts` copia tanto el binario como el manifest a `dist/runtime/agent-browser/`.

La estrategia de navegador depende de la plataforma. Windows x64, Linux x64 y macOS pueden usar Chrome for Testing administrado; Linux ARM64 usa un Chromium/Chrome del sistema porque Chrome for Testing no publica builds Linux ARM64. Si la preparación corre como root en Linux ARM64 y no existe navegador, intenta instalar Chromium mediante el gestor de paquetes disponible. En Docker se instala `chromium` directamente en la imagen runtime para la arquitectura real del contenedor y se omite la descarga de Chrome for Testing durante el build. El flujo normal sigue siendo `bun install` y después `bun run dev` o `bun run build`.

Ejemplo natural:

```text
Investiga los precios actuales de las APIs de DeepSeek, MiniMax, OpenAI y Anthropic. Compáralos y crea un PDF.
```

El flujo esperado es:

```text
Luna principal
  ↓
spawn_agents
  ├─ researcher-web: DeepSeek
  ├─ researcher-web: MiniMax
  ├─ researcher-web: OpenAI
  └─ researcher-web: Anthropic
  ↓
los cuatro resultados vuelven como tool_result
  ↓
Luna principal revisa todo
  ├─ si algo falta o parece dudoso → researcher_web adicional
  └─ si ya es suficiente → sintetiza
  ↓
workspace_write_text
  ↓
create_pdf_from_markdown
  ↓
whatsapp_send
```

`spawn_agents` no es terminal y no crea PDFs por sí mismo. Después de terminar, el agente principal sigue razonando normalmente. Esto permite que una investigación fallida se repita de forma enfocada sin reiniciar las demás y evita convertir la investigación en una mega-herramienta rígida.

Las solicitudes de subagentes se deduplican semánticamente dentro de la misma respuesta del modelo. Si un proveedor OpenAI-compatible repite accidentalmente la misma llamada con otro `tool_call_id`, el trabajo se ejecuta una sola vez.

Los subagentes de una misma llamada se ejecutan mediante `Promise.allSettled`, por lo que un fallo no cancela a los demás. La cancelación explícita con `/cancelar` sí se propaga desde la tarea padre hasta los `AbortController` de todos los hijos y sus búsquedas/lecturas en curso.

Las búsquedas de investigadores paralelos conservan la cola global multiproveedor: Tavily/Brave y los demás motores se serializan y respetan el intervalo mínimo configurado para evitar ráfagas HTTP 429, mientras otros agentes pueden seguir leyendo URLs en paralelo.

Cada ejecución se persiste en el workdir privado del usuario:

```text
persistent/contexts/<jid>/workdir/tasks/<task-id>/
├── agents/
│   ├── 01-researcher-web/
│   │   ├── request.json
│   │   ├── events.jsonl
│   │   ├── result.json
│   │   └── result.md
│   └── ...
└── result.json
```

`events.jsonl` registra inicio, herramientas usadas, finalización o fallo sin inyectar los cuerpos completos de las páginas al contexto principal. `result.md` conserva la respuesta completa del investigador y el resultado devuelto a Luna se limita cuando excede un tamaño seguro para el contexto.

`task_list`, `task_status` y `task_cancel` siguen disponibles para consultar o cancelar tareas desde lenguaje natural.

### Progreso visible en WhatsApp

Luna muestra solo eventos importantes:

```text
🤖 Inicié 4 subagentes.
Tarea: ...

🔎 Subagente 1/4 (researcher-web):
Investiga los precios actuales de DeepSeek...

✅ Subagente 1/4 (researcher-web): terminado.
```

El detalle completo de `web_search`, `read_url`, tiempos y errores permanece en el log debug de consola y en `events.jsonl`.

## PDF, ZIP, gitzip y envío de artefactos

Las herramientas de artefactos pueden:

- Convertir Markdown del workdir a un PDF multipágina con encabezados, párrafos, listas y tablas Markdown renderizadas como tablas reales con celdas, ajuste de texto y encabezados repetidos al cambiar de página.
- Detectar emojis Unicode con `@twemoji/parser` y renderizarlos como vectores Twemoji locales dentro del PDF, incluyendo secuencias compuestas y banderas, sin modificar el Markdown original ni depender de las fuentes emoji instaladas en Windows o Linux.
- Usar orientación horizontal automáticamente cuando una tabla tiene cinco o más columnas, evitando tablas de precios comprimidas o ilegibles.
- Comprimir una carpeta completa con `archive_folder`.
- Crear un ZIP de código con `gitzip`, respetando `.gitignore` de la raíz y de carpetas anidadas, negaciones `!`, excluyendo `.git/` y evitando enlaces externos.
- Resolver rutas contra el `realpath` del workdir y de su ancestro existente más cercano, bloqueando lecturas y escrituras que intenten escapar mediante symlinks o junctions externos.
- Detectar nombres sensibles como `.env`, claves privadas, credenciales, `persistent/` o sesiones de Baileys antes de compartir código.

`whatsapp_send` solo puede devolver contenido al mismo JID que originó la tarea. Imágenes, audio y video de hasta 10 MiB se envían con su tipo nativo; archivos mayores se envían como documento. Las carpetas se comprimen como ZIP antes de enviarse y cualquier tipo desconocido se trata como documento.

## `/config`

El administrador puede modificar el comportamiento del agente desde WhatsApp:

```text
/config
```

Opciones disponibles:

1. Activar o desactivar el acceso web del investigador.
2. Activar o desactivar el subagente investigador.
3. Cambiar la profundidad predeterminada entre estándar y profunda.
4. Cambiar el timeout de seguridad del investigador entre 5, 10, 15 y 30 minutos.

La configuración se guarda inmediatamente en:

```text
persistent/agent-config.json
```

La profundidad estándar solicita hasta 8 resultados por búsqueda. La profunda solicita hasta 15 y permite un flujo de investigación más amplio.

## Depuración completa en consola

La depuración estructurada está activa de forma predeterminada y usa colores ANSI para distinguir rápidamente cada subsistema:

- **cian**: búsquedas, cola y fallback entre motores;
- **magenta**: `read_url` y obtención del contenido de páginas;
- **azul**: runtime y herramientas de subagentes;
- **verde**: proveedor LLM y reintentos de IA;
- **amarillo**: cola y entrega de mensajes de WhatsApp;
- **rojo/amarillo**: errores definitivos y advertencias recuperables.

Durante una investigación se muestran en consola:

- ID de tarea, trabajador, proveedor y consulta;
- entrada y salida de la cola global de búsquedas;
- motor intentado, fallback, HTTP 429 y recuperación con el siguiente motor;
- URL abierta, duración, caracteres extraídos y errores de fetch;
- reintentos del proveedor LLM y abortado después de agotar intentos;
- mensajes de WhatsApp encolados durante una desconexión y vaciado al reconectar;
- creación de artefactos, entrega y stack completo de excepciones definitivas.

Los fallos intermedios de un motor de búsqueda se registran como `WARN`: no se devuelven al modelo si otro motor configurado completa la misma consulta. `web_search` solo retorna un error cuando todos los motores habilitados fallan.

Los campos con nombres sensibles como `apiKey`, `authorization`, `cookie`, `password`, `secret` o `credential` se sustituyen por `[REDACTED]`. También se reconocen prefijos inequívocos de claves conocidas sin ocultar URLs normales que contengan palabras como `api-pricing`. Las cadenas extensas se truncan salvo que se habilite el modo detallado.

Variables disponibles:

```bash
# Desactivar completamente los logs de depuración
LUNA_DEBUG=false

# Desactivar colores ANSI
LUNA_DEBUG_COLORS=false

# Mostrar cadenas extensas sin truncarlas
LUNA_DEBUG_VERBOSE=true

# Ajustar la cola global de motores de búsqueda
LUNA_SEARCH_CONCURRENCY=1
LUNA_SEARCH_MIN_INTERVAL_MS=1250
LUNA_SEARCH_RETRY_ATTEMPTS=3
LUNA_SEARCH_RETRY_BASE_MS=1500

# Reintentos del proveedor LLM. Incluye timeouts, 429/5xx,
# respuestas vacías y 400 transitorios como "Upstream request failed".
LUNA_LLM_RETRY_ATTEMPTS=3
LUNA_LLM_RETRY_BASE_MS=1500

# Cadencia de entrega de todos los mensajes salientes por WhatsApp.
# Si el socket se cierra, el mensaje queda temporalmente en memoria y
# se reenvía automáticamente al reconectar.
LUNA_WHATSAPP_MIN_DELAY_MS=1200
LUNA_WHATSAPP_MAX_DELAY_MS=2800
LUNA_WHATSAPP_SEND_RETRY_ATTEMPTS=3
```

Para Tavily Free se recomienda conservar concurrencia `1` e intervalo mínimo de `1250` ms. Los investigadores continúan en paralelo mientras esperan su turno para buscar y pueden leer y procesar sus fuentes de forma independiente. Si Tavily queda limitado y Brave, Exa u otro motor configurado está disponible, la misma consulta continúa automáticamente con el siguiente proveedor.

## Entrega resiliente por WhatsApp

Todos los mensajes salientes de Luna —respuestas finales, progreso de subagentes, avisos de herramientas, OCR/transcripción, alarmas, recordatorios y artefactos— pasan por una única cola de entrega. Antes de cada envío se simula brevemente el estado `composing`.

Si Baileys devuelve errores de desconexión como `Connection Closed`/HTTP 428 o el socket desaparece durante una tarea:

1. el mensaje no se descarta ni rompe el agente actual;
2. queda temporalmente pendiente en memoria y se preserva su orden;
3. los mensajes nuevos también se agregan a la misma cola;
4. al recibir un nuevo socket válido durante la reconexión, la cola se vacía secuencialmente aplicando nuevamente la simulación de escritura.

Los errores no relacionados con conectividad se reintentan con backoff antes de considerarse definitivos. La cola es temporal y no sustituye la persistencia propia de alarmas y recordatorios.

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

El volumen conserva la sesión de WhatsApp, usuarios, contextos, memoria, alarmas, configuración LLM, motores de búsqueda, credenciales y la configuración global de Whisper. Los modelos Whisper descargados por `!setup-whisper` también permanecen en el volumen. Docker instala Chromium y las bibliotecas Linux necesarias mediante APT para la arquitectura de la imagen, por lo que el mismo Dockerfile funciona en amd64 y ARM64 sin intentar Chrome for Testing en ARM64. El entrypoint mantiene `/data/bot` y `/data/runtime` de solo lectura para `appuser` y ubica HOME, caché, estado y sockets XDG bajo `/data/persistent`. Los audios e imágenes originales se procesan temporalmente y no se conservan. No es necesario montar archivos adicionales.

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
| `!cambiar-password` | Cambia la contraseña de la cuenta autenticada; si no se incluye el valor, inicia una captura segura. |
| `/cancelar` | Cancela el flujo interactivo actual. |
| `!clear` | Reinicia la conversación sin borrar la memoria persistente. |
| `!clear-workdir confirmar` | Limpia todo el workdir privado del usuario sin borrar conversación, memoria ni configuración. |
| `!limpiar-workdir confirmar` | Alias en español de `!clear-workdir`. |
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

Todos los comandos funcionales de una sesión autenticada tienen una vía equivalente por lenguaje natural. Un usuario puede pedir ayuda, consultar su JID, cancelar una operación, limpiar su conversación, listar o cambiar el modelo y limpiar su propio workdir sin recordar el comando exacto. `!setup` y `!login` también aceptan frases naturales como “crear administrador” o “iniciar sesión”, pero siguen procesándose localmente para no enviar credenciales al proveedor LLM.

Los administradores heredan todas las capacidades normales y además pueden administrar por lenguaje natural usuarios, Whisper, proveedor LLM, motores de búsqueda y las opciones funcionales de `/config`. Si una API key de un motor se incluye directamente en la misma frase natural (por ejemplo, "usa esta key en Firecrawl: ..."), Luna detecta proveedor y secreto localmente, la guarda de inmediato y evita pedirla otra vez. Si el secreto todavía no se proporcionó, inicia la captura segura en el siguiente mensaje. El cambio de contraseña funciona de la misma manera para cualquier usuario autenticado y también está disponible mediante `!cambiar-password`. Los secretos capturados por estas rutas se procesan fuera del LLM cuando es posible y Luna intenta borrar el mensaje que los contiene. Los parámetros internos de resiliencia, reintentos y backoff no se exponen como herramientas naturales.

Ejemplos de administración natural:

- “¿Qué proveedor LLM estamos usando?”
- “Vuelve a OpenCode Free.”
- “Quiero configurar un proveedor personalizado.”
- “Muéstrame los buscadores configurados.”
- “Pon Brave primero y Tavily como segundo fallback.”
- “Prueba todos los motores activos.”
- “Configura la API key de Exa.”
- “Usa investigación profunda por defecto.”
- “Desactiva temporalmente el subagente investigador.”
- “Muéstrame los modelos Whisper disponibles.”
- “Crea un usuario llamado pedro.”

## Persistencia

```text
persistent/
├── auth_info_baileys/       # Sesión de WhatsApp
├── contexts/<jid>/
│   ├── context.json         # Conversación, alarmas entregadas, modelo y compactación
│   ├── memory.md            # Memoria duradera del usuario
│   ├── reminders.json       # Recordatorios de una sola vez
│   ├── alarms.json          # Alarmas recurrentes
│   └── workdir/             # Tareas, temporales y artefactos privados
├── agent-config.json        # Configuración de herramientas y subagente
├── search.json              # Motores, estados, predeterminado y fallback
├── search-auth.json         # API keys de búsqueda; secreto
├── llm.config.json          # Solo si existe proveedor LLM personalizado
├── whisper.json             # Modelo y parámetros globales de transcripción
├── whisper/models/          # Modelos adicionales descargados por el administrador
├── browser/                 # Clave y perfiles cifrados de credenciales/sesiones web
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
├── prepare-agent-browser.ts # Prepara binario nativo y navegador compatible
├── prepare-media-assets.ts  # Descarga latest, repara y valida whisper.cpp
├── package-runtime.ts       # Copia runtimes preparados a dist/
├── whisper-linux-libs.ts    # Preserva SONAME e incluye libgomp.so.1 portable
├── remove-legacy-research.py # Elimina el pipeline de investigación legado
└── remove-context-noise.py  # Limpia registros duplicados/espurios de contexto

src/
├── ai.ts                    # Chat completions, tools, timeout y catálogo LLM
├── agent-config.ts          # Configuración persistente y flujo /config
├── agents/                  # Runtime agéntico, registro, eventos y subagentes aislados
│   └── definitions/         # Definiciones como researcher-web
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
│   ├── read-url.ts          # Lectura y extracción Markdown con protecciones SSRF
│   ├── search-config.ts     # Tipos, proveedores y normalización
│   ├── search-runtime.ts    # Adaptadores y fallback multiproveedor
│   ├── search-setup.ts      # Flujo /setup-search
│   ├── search-storage.ts    # Preferencias y credenciales separadas
│   └── search-tools.ts      # web_search, uso exclusivo del subagente
├── workspace/               # Workdir aislado, rutas seguras y artefactos
├── orchestration/           # Persistencia y cancelación de tareas
├── artifacts/               # PDF, ZIP y gitzip
├── tools/                   # Envío de artefactos por WhatsApp
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
7. Enviar una pregunta sobre un único tema actual y confirmar que el modelo principal use `researcher_web`.
8. Pedir una comparativa de cuatro temas y confirmar que use una sola llamada `spawn_agents` con cuatro `researcher-web` en paralelo.
9. Confirmar que, al terminar `spawn_agents`, Luna recupere el control y pueda crear Markdown/PDF y enviarlo sin que el subagente haga esas acciones.
10. Forzar el fallo de un investigador y comprobar que los demás terminen y que Luna pueda lanzar solo una investigación adicional para el tema faltante.
11. Revisar `context.json` y comprobar que no contenga páginas completas; revisar `workdir/tasks/<task-id>/agents/*/events.jsonl` para la trazabilidad.
12. Intentar provocar la lectura de una URL privada o local y verificar que sea rechazada.
13. Desactivar búsqueda y subagentes desde `/config` y comprobar que `researcher_web` y `spawn_agents` desaparezcan.
14. Abrir `!setup-whisper`, comprobar el catálogo, cambiar un parámetro y verificar `persistent/whisper.json`.
15. Descargar un modelo alternativo pequeño, activarlo y comprobar que se conserve después de reiniciar.
16. Enviar una nota de voz OGG/Opus en español, verificar el progreso, la transcripción y que Luna responda al contenido.
17. Enviar una imagen JPEG o PNG con texto, verificar el OCR y que el pie de imagen también llegue al asistente.
18. Probar un audio mayor que la duración configurada y una imagen mayor de 10 MB para confirmar que se rechacen antes de procesarlos.
19. Reiniciar el contenedor con el mismo volumen y verificar que toda la configuración persista.
20. Pedir una comparación de cuatro proveedores y verificar que se use una sola tarea paralela, con carpetas independientes, continuación ante un fallo y entrega del PDF.
21. Abrir el PDF y comprobar que las tablas Markdown se dibujen como celdas reales, sin mostrar los caracteres `|`.
22. Crear un proyecto con `.gitignore` anidados, ejecutar `gitzip` y revisar que no incluya `.git/` ni archivos ignorados.
23. Enviar una imagen menor de 10 MiB, un video mayor de 10 MiB y una carpeta; comprobar imagen nativa, documento y ZIP.
24. Forzar el máximo de rondas de herramientas después de un envío exitoso y confirmar que Luna cierre con el resultado, sin mostrar “excedió el número de llamadas”.
25. Repetir creación, entrega y reintento de alarmas y recordatorios antes y después de reiniciar.
26. Crear un symlink/junction dentro del workdir que apunte fuera y verificar que una escritura nueva a través de ese directorio sea rechazada.
27. Probar una copia con `persistent/browser/encryption.key` corrupta y confirmar que el archivo no sea reemplazado automáticamente.

## Limpieza reproducible

Los scripts de limpieza son Python puro y funcionan desde PowerShell, CMD, Linux o macOS. Antes de aplicar una limpieza de contexto se puede revisar el alcance exacto:

```powershell
python .\scripts\remove-context-noise.py --dry-run
python .\scripts\remove-context-noise.py
```

`remove-context-noise.py` solo toca las rutas enumeradas dentro del propio script y no modifica `persistent/`, `assets/`, `dist/` ni `node_modules/`.
