# 90 — Corregir alias read_url y tests de browser

# Fecha

2026-07-24

# Objetivo

Corregir dos regresiones detectadas por la suite después de introducir web pública directa y el toolset progresivo de subagentes.

# Correcciones

## Alias lógico de read_url en researcher-web

`READ_URL_TOOL` conserva `api-search.read-url` como nombre físico/namespaced para la superficie principal, pero `researcher-web` trabaja deliberadamente con el nombre lógico `read_url` en su allowlist, prompt y dispatcher.

`AgentRuntime` ahora clona el schema al enlazarlo al subagente y expone `read_url` como `function.name`. Esto evita que el modelo reciba `api-search.read-url` y luego el dispatcher rechace esa llamada por esperar `read_url`.

El alias no modifica la definición global y por tanto no rompe la superficie namespaced del agente principal.

## Test de routing browser/public-web

La prueba de integración dejó de depender de la frase histórica `navegación/scraping de un dominio`. Ahora valida la política vigente: browser-agent se usa para navegación/scraping interactivo y se prioriza `public-web` en búsquedas/descargas públicas simples.

# Regresión cubierta

La prueba de `AgentRuntime` verifica que el primer request del investigador incluya `read_url` y no `api-search.read-url`, además de mantener el lazy loading de workspace.

# Validación

La suite completa debe ejecutarse en el host con Bun mediante `bun run test`, seguida de `bun run typecheck` y `bun run build`.
