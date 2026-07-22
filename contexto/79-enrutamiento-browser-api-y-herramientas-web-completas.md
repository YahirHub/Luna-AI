# 79 — Enrutamiento browser/api y herramientas web completas

# Fecha

2026-07-21

# Objetivo

Distinguir de forma automática cuándo una misión debe usar navegación interactiva (`browser-agent`) y cuándo basta una consulta a motores de búsqueda (`api-search`), ampliar la capacidad de auditoría del navegador y permitir que el orquestador y los subagentes administren archivos dentro de sus workdirs autorizados.

# Enrutamiento

- `api-search` se usa para búsquedas públicas rápidas, noticias, información actual, comparaciones y consultas multiproveedor cuando existen motores configurados mediante `/setup-search`.
- `browser-agent` se usa para un dominio o URL específicos cuando la misión requiere recorrer páginas, seguir navegación interna, extraer contenido por ruta, auditar HTML/DOM, revisar una aplicación, iniciar sesión, obtener capturas o descargar imágenes, favicon y demás recursos.
- Si el modelo solicita `researcher-web` pero el prompt contiene un dominio/URL y una intención clara de scraping o auditoría, el ejecutor lo cambia automáticamente a `browser-web`.
- Una instrucción explícita para usar `api-search` conserva ese backend.

# Misiones completas en WhatsApp

Se eliminó el corte histórico de 700 caracteres. Los mensajes de inicio conservan la misión completa y, cuando exceden el tamaño seguro, se dividen en bloques numerados sin perder contenido.

# Herramientas nuevas de browser-agent

- `browser_get_html`: obtiene y guarda HTML renderizado.
- `browser_eval`: inspección JavaScript limitada del DOM; bloquea intentos de leer cookies, contraseñas, portapapeles o almacenes sensibles.
- `browser_console` y `browser_errors`: inspección de consola y errores.
- `browser_network_requests` y `browser_network_request`: listado y detalle de solicitudes de red.
- `browser_extract_assets`: inventario de imágenes, favicon, scripts, estilos y enlaces.
- `browser_download_assets`: descarga controlada de imágenes/favicon con límites de cantidad/tamaño, redirects restringidos y protección contra SSRF.
- `browser_pdf`: exportación de la página actual.

Los resultados extensos se guardan como archivos dentro de la carpeta de la ejecución para que el orquestador pueda revisarlos sin saturar el contexto.

# Herramientas de workdir

El orquestador incorpora:

- `workspace_append_text`
- `workspace_edit_text`
- `workspace_delete` con confirmación explícita

Los subagentes incorporan variantes `agent_workspace_list/read_text/write_text/append_text/edit_text/delete`, confinadas a su propia carpeta. No pueden eliminar la raíz de la ejecución ni escapar mediante traversal o enlaces simbólicos.

# Limpieza de api-search

Al llegar a un estado terminal se liberan los controladores de aborto, terminadores y referencias efímeras de cada agente y tarea. Se conservan únicamente registros, eventos y resultados persistentes necesarios para revisión. No se mantienen procesos de búsqueda ni timers de reintento después de terminar o cancelar.

# Tasklist futura

La lista persistente de pasos/verificación para garantizar que una tarea compleja no se cierre con acciones pendientes se reserva para la siguiente implementación, según la solicitud del usuario. Esta entrega solo deja disponibles las primitivas de workdir, inspección y estado que esa tasklist utilizará.

# Archivos principales

- `src/agents/spawn-agents-tool.ts`
- `src/agents/definitions/browser-web.ts`
- `src/agents/definitions/researcher-web.ts`
- `src/agents/agent-runtime.ts`
- `src/browser/browser-tools.ts`
- `src/browser/browser-runtime.ts`
- `src/workspace/workspace-manager.ts`
- `src/workspace/workspace-tools.ts`
- `src/workspace/agent-workspace-tools.ts`
- `src/orchestration/task-runtime.ts`
- `src/bot.ts`
- `src/context.ts`

# Entrega

Proyecto completo en ZIP. No se añaden scripts Python de eliminación.
