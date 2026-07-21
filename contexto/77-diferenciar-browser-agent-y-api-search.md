# 77 — Diferenciar browser-agent y api-search

# Fecha

2026-07-21

# Problema

Las tareas de navegación interactiva y las investigaciones mediante proveedores de búsqueda se mostraban con nombres internos (`browser-web` y `researcher-web`) o como agentes genéricos. En el chat y en consola no siempre era evidente si Luna estaba controlando un navegador real o consultando las APIs configuradas mediante `/setup-search`. Los logs internos de búsqueda tampoco incluían de forma consistente el ID corto y nombre del agente supervisor.

# Solución

Se añadió un backend explícito a cada definición y registro de agente:

- `browser-agent`: controla `agent-browser`, Chrome y herramientas `browser_*`.
- `api-search`: usa `web_search`, `read_url` y los proveedores configurados mediante `/setup-search`.

Los tipos internos `browser-web` y `researcher-web` se conservan para compatibilidad con prompts, herramientas y tareas persistidas. Los registros antiguos que no tienen backend se normalizan automáticamente según su `agentType` al cargarse.

# Visibilidad en chat y supervisor

Los mensajes de inicio y finalización muestran ahora, por ejemplo:

```text
🚀 browser-agent A-12AB34 activo — Revisar panel
🚀 api-search A-56CD78 activo — Investigar precios
```

`agent_list`, `agent_status`, `task_status`, el resumen autoritativo y las solicitudes de credenciales incluyen también el backend. Así el usuario puede distinguir inmediatamente si un agente está navegando o consultando APIs.

# Logs

La navegación utiliza scopes separados:

- `agent.browser-agent`
- `browser-agent.runtime`
- `supervisor.browser-agent`

La investigación por API utiliza:

- `agent.api-search`
- `api-search.runtime`
- `api-search.queue`
- `api-search.retry`
- `api-search.read-url`
- `supervisor.api-search`

Cada evento relevante incorpora `taskId`, `agentId`, `agentName`, `agentType`, `runId`, acción actual y, cuando aplica, comando de navegador, consulta, proveedor, endpoint o herramienta.

# Compatibilidad

No se cambiaron los IDs internos de herramientas ni agentes, por lo que las tareas existentes, prompts guardados y llamadas `agent_type=browser-web/researcher-web` siguen funcionando. Los archivos `tasks.json` antiguos se migran de forma compatible al leerlos sin exigir una conversión manual.

# Pruebas

Se añadió una regresión que comprueba:

- asignación correcta de `browser-agent` y `api-search`;
- persistencia y normalización del backend;
- inclusión del backend en el contexto autoritativo;
- scopes separados para navegador y búsqueda;
- identidad del supervisor en los logs.
