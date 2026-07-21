# 74 — Supervisor de tareas, agentes en segundo plano y cierre de agent-browser

# Fecha

2026-07-20

# Objetivo

Evitar procesos residuales de `agent-browser`, permitir que la conversación principal continúe mientras un agente de navegador trabaja y dar al orquestador control explícito sobre tareas/agentes activos, terminados, pendientes de revisión y revisados.

# Cambios de arquitectura

## Registro central de tareas y agentes

`TaskRuntime` evoluciona a un supervisor persistente con dos niveles:

- tarea padre con `task_id`, título, progreso y `reviewStatus`;
- agentes individuales con ID corto `A-XXXXXX`, nombre, tipo, `runId`, estado, ruta de resultado y `reviewStatus`.

Estados de ejecución de agente:

- `queued`
- `running`
- `waiting_user`
- `completed`
- `failed`
- `cancelled`
- `interrupted`

Estados de revisión:

- `pending`: el agente terminó, pero Luna todavía no inspeccionó su resultado;
- `reviewed`: el resultado ya fue devuelto al orquestador mediante `agent_review`/`task_review` o fue consumido síncronamente por la ejecución padre.

La persistencia `tasks.json` pasa a versión 2 y conserva compatibilidad con registros anteriores.

## Ejecución en segundo plano

`browser_agent` usa `background=true` por defecto. La tool crea la tarea, registra el agente y devuelveve el `task_id` inmediatamente. La Promise real continúa fuera de la ejecución conversacional, por lo que el lock del contexto se libera al terminar la respuesta principal y el usuario puede seguir hablando con Luna.

`spawn_agents` conserva comportamiento síncrono por defecto para comparativas/investigaciones que deban sintetizarse en la misma respuesta, pero acepta `background=true`.

Cada turno nuevo recibe mediante `TaskRuntime.buildContextSummary()` un resumen compacto con:

- agentes activos;
- agentes esperando datos del usuario;
- resultados terminados pendientes de revisión;
- agentes revisados recientemente.

## Herramientas del orquestador

Se agregan/amplían:

- `task_list`
- `task_status`
- `task_review`
- `task_cancel`
- `task_cancel_all`
- `agent_list`
- `agent_status`
- `agent_review`
- `agent_cancel`

`task_review` y `agent_review` leen el `result.md` persistido y después marcan el resultado como `reviewed`.

`task_cancel` y `agent_cancel` ya no abortan `runController` de la conversación principal. La conversación puede seguir razonando y responder después de detener trabajo de fondo.

La cancelación explícita global `!cancelar` conserva la capacidad de abortar la operación conversacional actual y todas las tareas activas. Las frases ambiguas como `cancélalo`/`deténlo` dejan de convertirse automáticamente en una cancelación global cuando hay una sesión normal: el orquestador puede seleccionar el agente o tarea correcto usando el contexto inyectado.

## Esperas de datos humanos

Cuando `browser_request_user_input` pausa un navegador, el agente pasa a `waiting_user`. Al recibir el dato vuelve a `running`.

Si el usuario responde `cancélalo`, `deténlo`, `déjalo` o equivalente mientras existe esa espera, se cancela el agente `waiting_user` correspondiente y la espera segura de credenciales/datos se rechaza.

## Ciclo de vida de agent-browser

Cada `BrowserAgentExecution` usa ahora:

- namespace `AGENT_BROWSER_NAMESPACE` exclusivo por `jid + runId`;
- runtime temporal `persistent/browser/runs/<runId>`;
- `AGENT_BROWSER_IDLE_TIMEOUT_MS=10000` por defecto, con keepalive interno cada 4 segundos mientras la ejecución está activa;
- registro de procesos CLI activos de la ejecución.

Al finalizar una misión, fallar o cancelarse:

1. intenta guardar `session-state.json` persistente;
2. ejecuta `agent-browser close`;
3. ejecuta `agent-browser close --all` dentro del namespace exclusivo del run;
4. termina procesos CLI que continúen activos, escalando de `SIGTERM` a `SIGKILL` cuando sea necesario;
5. libera el lease del perfil;
6. elimina únicamente el directorio temporal del run.

No se usa `killall agent-browser` ni se matan procesos externos no registrados. Los datos persistentes por usuario en `persistent/browser/users/` permanecen intactos.

El namespace exclusivo permite que el cierre total del run no afecte a otros agentes. El idle timeout hace que el daemon persistente asociado al run salga después de quedar inactivo, reduciendo procesos huérfanos tras finalizaciones y crashes.

## Recuperación tras reinicio

Al construir `TaskRuntime`, los `tasks.json` persistidos que quedaron en `running`/`synthesizing` se marcan `interrupted/pending`; agentes `queued`, `running` o `waiting_user` también pasan a `interrupted/pending`.

Así Luna no presenta una tarea antigua como eternamente activa después de reiniciar.

# Archivos principales modificados

- `src/orchestration/task-runtime.ts`
- `src/agents/spawn-agents-tool.ts`
- `src/agents/agent-types.ts`
- `src/browser/browser-runtime.ts`
- `src/bot.ts`
- `src/context.ts`
- `README.md`
- `__tests__/agent-supervisor.test.ts`
- `__tests__/agentic-integration-source.test.ts`
- `__tests__/browser-session-persistence-source.test.ts`

# Pruebas recomendadas

1. Lanzar un `browser_agent` de varios minutos y enviar mensajes normales durante su ejecución.
2. Ejecutar `agent_list` mientras corre y confirmar `running`.
3. Esperar a que termine y comprobar `completed/pending`.
4. Ejecutar `agent_review` y comprobar que devuelve el resultado y cambia a `reviewed`.
5. Lanzar dos agentes y cancelar solo uno mediante su `A-XXXXXX` o nombre.
6. Ejecutar `task_cancel_all` y verificar que se detengan todos los trabajos de fondo sin abortar la respuesta conversacional actual.
7. Cancelar un navegador mientras ejecuta un comando y comprobar que no quede bloqueado el siguiente `browser_agent`.
8. Verificar tras finalizar que el runtime temporal del run desaparezca y el estado persistente del usuario siga disponible.
9. Reiniciar Luna con una tarea marcada artificialmente como `running` y comprobar recuperación a `interrupted/pending`.

# Restricción de entrega

Este cambio no crea ningún script Python de eliminación. La entrega está pensada para reemplazar el código con el ZIP completo proporcionado por el asistente.


## Entrega por reemplazo completo

Esta entrega está pensada para sustituir el código con el ZIP completo. No se generan ni se incluyen scripts Python de eliminación para rutas antiguas; los helpers históricos de migración `remove-*.py` ya no forman parte del árbol operativo entregado.
