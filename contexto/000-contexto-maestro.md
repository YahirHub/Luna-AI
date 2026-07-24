# 000 — Contexto maestro de Luna AI

# Fecha

2026-07-24

# Fuente de verdad

Este archivo es la entrada canónica. Después deben leerse los registros numerados recientes y comprobar el código fuente antes de modificarlo.

# Reglas de entrega

- Entregar siempre el proyecto completo en ZIP, preservando estructura y contenido salvo cambios solicitados.
- No incluir node_modules, artefactos temporales ni scripts Python para eliminar archivos.
- Conservar persistent/ al reemplazar una instalación para no perder sesiones, usuarios, memoria, credenciales y tareas.
- Ejecutar `bun install` antes de typecheck/pruebas/build en instalaciones nuevas; los ZIP no incluyen `node_modules`.
- Ejecutar typecheck, pruebas y build cuando el entorno permita descargar runtimes.

# Arquitectura vigente

- El modelo LLM es global. /setup-provider pide URL base y API key, deriva endpoints, consulta /models y obliga a seleccionar un modelo por número.
- La mensajería usa MessagingTransport. Baileys está aislado en src/transports/baileys y administra presencia, simulación de escritura y cola. --transport o LUNA_TRANSPORT seleccionan el runner.
- Los grupos de WhatsApp se ignoran antes de autenticación, comandos, multimedia o LLM.
- El audio OGG/Opus se normaliza con FFmpeg administrado y se transcribe con whisper.cpp.
- El agente principal usa una ruta HTTP/API directa para búsqueda, inspección y descarga de contenido público cuando no hace falta interacción: Wikimedia Commons se prioriza para imágenes/medios reutilizables, Internet Archive para video/audio/objetos públicos y Dogpile para descubrimiento web general cuando no hay una API de búsqueda mejor. browser-agent queda como escalamiento para JavaScript, interacción, login, CAPTCHA, auditoría visual o cuando HTTP/API directa no sea suficiente; api-search sigue cubriendo investigación pública multiproveedor.
- Tareas y agentes tienen IDs, nombres, estado de ejecución y estado de revisión pending/reviewed.
- browser-agent y api-search se ejecutan en segundo plano por defecto, por lo que el chat sigue disponible.
- Las tareas background conservan la solicitud y contexto que las originaron; su revisión automática continúa obligaciones pendientes (comparar, decidir, sintetizar, etc.) en lugar de limitarse a resumir al subagente. Las finalizaciones se integran FIFO por conversación y esperan a un foreground ya en curso antes de tomar el contexto post-delegación.
- La cancelación se procesa por una ruta prioritaria antes del lock de conversación. El AbortSignal llega a cola, reintentos, búsquedas, read_url y navegador.
- El orquestador revisa automáticamente resultados, eventos, carpetas y artefactos de tareas terminadas; las misiones largas se envían completas por WhatsApp en bloques numerados.
- agent-browser usa HOME, perfil, namespace y runtime aislados por ejecución; puede inspeccionar HTML/DOM, consola, errores, red, assets y PDF, y el estado autenticado portable se fusiona al finalizar. `browser_find_html` permite buscar coincidencias/URLs dentro del HTML renderizado localmente sin inyectar el documento completo al LLM.
- Los logs distinguen agent.browser-agent, browser-agent.runtime, agent.api-search, api-search.queue, api-search.retry, api-search.runtime y api-search.read-url, e incluyen contexto de tarea/agente. Los runtimes efímeros de búsquedas terminadas se liberan explícitamente.

- Orquestador y subagentes pueden crear, leer, añadir, editar y eliminar archivos dentro de sus workdirs autorizados; la eliminación global exige confirmación y los agentes quedan confinados a su carpeta.
- La memoria tiene dos niveles: `memory.md` conserva el perfil compacto y `persistent/contexts/<jid>/vault/` guarda notas temáticas Markdown compatibles con Obsidian, con propiedades YAML, tags, alias, wikilinks, backlinks, búsqueda ponderada, caché, renombrado seguro y papelera recuperable.
- El orquestador dispone de herramientas `memory_vault_*`; cuando enumera datos guardados debe consultar la bóveda real. Fragmentos relevantes se recuperan automáticamente sin inyectar todas las notas en cada turno.
- Las capacidades se registran en `src/modules/`: cada módulo declara permisos, comandos, tools, prompt y contexto. Antes del login no se exponen capacidades; `!setup`/`!login` son únicamente bootstrap. Una tool no declarada en un módulo se rechaza por defecto y `!ayuda` se genera desde el catálogo según el rol.
- El toolset es progresivo: cada turno expone solo módulos detectados por intención/estado y una superficie eager pequeña. `capability_load` puede ampliar una capacidad dentro del mismo loop; las tools marcadas `defer` solo aparecen tras esa carga explícita. Goals, skills y TTS ya no son módulos permanentes.
- El catálogo completo de skills no se inyecta: `skill_search` hace descubrimiento local y `skill_load` trae solo el `SKILL.md` necesario. Su cuerpo no se persiste en el historial global.
- `memory.md` puede conservar hasta 64k para compatibilidad, pero el contexto automático de perfil está limitado a 4k; el resumen compactado reinyectado está limitado a 8k y resultados grandes de tools se virtualizan mediante `result_ref`/`tool_result_read`.
- La política TTS distingue preferencias de un turno frente a cambios persistentes; una petición explícita de texto bloquea `tts_speak` en runtime y los resultados diferidos respetan el modo actual para evitar audios tardíos.

# Seguridad

- Workdirs aislados por usuario y protegidos contra traversal y symlinks externos.
- Credenciales web cifradas con AES-256-GCM; una clave corrupta no se reemplaza silenciosamente.
- Contraseñas, OTP, API keys, tokens y respuestas de seguridad se capturan fuera del LLM y se vinculan a la solicitud/agente correcto mediante referencias opacas.
- browser-web posee un guard autoritativo: si intenta cerrar una misión porque falta usuario, contraseña, OTP, API key/token, CAPTCHA textual, respuesta de seguridad u otro dato humano, el runtime usa `browser_request_user_input` y reanuda la misma sesión sin depender de que el orquestador lo haya anticipado. En una nueva orden explícita de login, la identidad debe venir del usuario o de una credencial temporal `browser-cred-*` capturada para esa petición; una `browser-profile-*` persistente no autoriza por sí sola la cuenta y nunca se infiere identidad desde perfiles, dominio, sesión persistida o campos prellenados.
- message_send no permite enviar ZIP con posibles credenciales sin confirmación explícita.

# Último registro

- `contexto/90-corregir-alias-read-url-y-tests-browser.md`
