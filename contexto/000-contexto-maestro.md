# 000 — Contexto maestro de Luna AI

# Fecha

2026-07-21

# Fuente de verdad

Este archivo es la entrada canónica. Después deben leerse los registros numerados recientes y comprobar el código fuente antes de modificarlo.

# Reglas de entrega

- Entregar siempre el proyecto completo en ZIP, preservando estructura y contenido salvo cambios solicitados.
- No incluir node_modules, artefactos temporales ni scripts Python para eliminar archivos.
- Conservar persistent/ al reemplazar una instalación para no perder sesiones, usuarios, memoria, credenciales y tareas.
- Ejecutar typecheck, pruebas y build cuando el entorno permita descargar runtimes.

# Arquitectura vigente

- El modelo LLM es global. /setup-provider pide URL base y API key, deriva endpoints, consulta /models y obliga a seleccionar un modelo por número.
- La mensajería usa MessagingTransport. Baileys está aislado en src/transports/baileys y administra presencia, simulación de escritura y cola. --transport o LUNA_TRANSPORT seleccionan el runner.
- Los grupos de WhatsApp se ignoran antes de autenticación, comandos, multimedia o LLM.
- El audio OGG/Opus se normaliza con FFmpeg administrado y se transcribe con whisper.cpp.
- El agente principal delega navegación/auditoría de dominios específicos a browser-agent y búsquedas públicas rápidas/multiproveedor a api-search. Las misiones de scraping con URL se redirigen automáticamente al navegador.
- Tareas y agentes tienen IDs, nombres, estado de ejecución y estado de revisión pending/reviewed.
- browser-agent y api-search se ejecutan en segundo plano por defecto, por lo que el chat sigue disponible.
- La cancelación se procesa por una ruta prioritaria antes del lock de conversación. El AbortSignal llega a cola, reintentos, búsquedas, read_url y navegador.
- El orquestador revisa automáticamente resultados, eventos, carpetas y artefactos de tareas terminadas; las misiones largas se envían completas por WhatsApp en bloques numerados.
- agent-browser usa HOME, perfil, namespace y runtime aislados por ejecución; puede inspeccionar HTML/DOM, consola, errores, red, assets y PDF, y el estado autenticado portable se fusiona al finalizar.
- Los logs distinguen agent.browser-agent, browser-agent.runtime, agent.api-search, api-search.queue, api-search.retry, api-search.runtime y api-search.read-url, e incluyen contexto de tarea/agente. Los runtimes efímeros de búsquedas terminadas se liberan explícitamente.

- Orquestador y subagentes pueden crear, leer, añadir, editar y eliminar archivos dentro de sus workdirs autorizados; la eliminación global exige confirmación y los agentes quedan confinados a su carpeta.

# Seguridad

- Workdirs aislados por usuario y protegidos contra traversal y symlinks externos.
- Credenciales web cifradas con AES-256-GCM; una clave corrupta no se reemplaza silenciosamente.
- Contraseñas y OTP se capturan fuera del LLM y se vinculan a la solicitud/agente correcto.
- message_send no permite enviar ZIP con posibles credenciales sin confirmación explícita.

# Último registro

- `contexto/79-enrutamiento-browser-api-y-herramientas-web-completas.md`
