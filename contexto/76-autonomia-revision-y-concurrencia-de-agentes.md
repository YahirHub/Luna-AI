# 76 — Autonomía, revisión y concurrencia real de agentes

# Fecha

2026-07-20

# Problema

El supervisor anterior podía registrar una tarea y el bot anunciarla como activa antes de confirmar que el runtime del subagente hubiera comenzado. Las tareas terminadas quedaban `pending` hasta una revisión manual, las preguntas de estado dependían de inferencias del modelo y una solicitud humana pendiente podía capturar mensajes que correspondían a otra conversación o agente. Además, cada navegador usaba un perfil vivo compartido, impidiendo concurrencia real.

# Cambios

- Las tareas nuevas se registran como `queued`; únicamente `agent_started` confirma que un agente está realmente ejecutándose.
- Cada agente registra actividad actual, herramienta, último evento y metadatos de la solicitud humana pendiente.
- Las consultas naturales de progreso se responden desde `TaskRuntime`, con IDs, estados y actividad autoritativa.
- Se añadió `task_inspect` para leer resultados, eventos, carpeta recursiva y artefactos reales.
- Al terminar una tarea en segundo plano, el orquestador revisa automáticamente su carpeta, sintetiza el resultado, lo agrega al contexto y envía artefactos relevantes. Los fallos de revisión quedan pendientes para reintento.
- `browser_request_user_input` admite varias solicitudes simultáneas identificadas por agente/request ID, captura la página anotada antes de preguntar y permite reintentar usuario, contraseña, OTP u otros datos sin abortar la sesión.
- Los mensajes normales ya no se consumen solo porque exista una solicitud pendiente; cuando hay ambigüedad se exige responder con el ID del agente.
- Cada ejecución `browser-web` tiene HOME, perfil Chrome, sesión y daemon propios. El estado autenticado se restaura desde un archivo portable por usuario y se fusiona al finalizar bajo un lease corto de guardado.
- `browser_open` incorpora un snapshot inicial compacto. El prompt de `browser-web` reduce pasos repetidos, exige confirmar el estado final y usa menos pasos/tokens para tareas simples.
- La carpeta de cada agente queda disponible para el revisor automático y el orquestador.

# Seguridad

- Contraseñas y OTP siguen fuera del contexto del LLM.
- Una respuesta ambigua no se asigna a ningún agente cuando existen varias solicitudes pendientes.
- Las capturas temporales usadas para explicar un campo no se confunden con entregables finales.
- La terminación de procesos continúa limitada a namespaces y procesos registrados por Luna; no se usa `killall`.

# Validación

- `bun run typecheck`: correcto.
- `bun test`: 426 pruebas correctas, 0 fallos, 1237 aserciones.
- Se añadieron regresiones para inicio autoritativo, inspección de tareas, concurrencia de perfiles, fusión de cookies/localStorage, solicitudes simultáneas y corrección/reintento de datos humanos.
