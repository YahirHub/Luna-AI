# 77 — Diferenciar browser-agent y api-search

Navegación interactiva se identifica como browser-agent; búsquedas mediante /setup-search como api-search. Los logs heredan taskId, agentId, nombre, tipo, runId y backend mediante AsyncLocalStorage. Scopes de cola, reintentos, proveedores, lectura URL y comandos de navegador son distintos.
