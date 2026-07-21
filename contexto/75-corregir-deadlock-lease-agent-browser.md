# 75 — Corregir deadlock del lease de agent-browser

# Fecha

2026-07-20

# Problema observado

Después de lanzar más de una tarea `browser-web`, cancelar tareas en espera podía dejar todas las ejecuciones posteriores detenidas en `browser_open`.

El log mostraba `agent.runtime.tool_started` para `browser_open`, pero no aparecía después `browser.runtime.command_started`. Esto indicaba que el bloqueo ocurría antes de ejecutar el CLI de `agent-browser`.

# Causa raíz

Cada usuario comparte un perfil persistente de Chrome y `BrowserAgentExecution` serializa su uso mediante un lease.

La implementación anterior reservaba la posición en la cola desde el constructor. Si un segundo agente esperaba el lease del primero y era cancelado durante esa espera:

1. `cancel()` ejecutaba `finalize()`;
2. como el segundo agente todavía no había adquirido el lease, `finalize()` terminaba sin liberarlo;
3. cuando el primer agente finalmente liberaba el perfil, la Promise pendiente del segundo adquiría su lease;
4. la ejecución ya estaba cancelada y no existía una finalización posterior capaz de liberar ese lease;
5. todos los agentes creados después quedaban esperando indefinidamente antes de `browser.runtime.command_started`.

# Corrección

- El lease deja de solicitarse de forma anticipada en el constructor y se adquiere de manera perezosa cuando una operación de navegador realmente lo necesita.
- `acquireBrowserProfileLease()` acepta ahora un `AbortSignal`.
- Si un agente se cancela mientras está esperando, su entrada de la cola se resuelve automáticamente al llegar su turno y permite avanzar a la siguiente ejecución.
- Se mantiene una segunda defensa después de adquirir el lease: si la ejecución ya está cancelada o finalizando, el lease se libera inmediatamente antes de lanzar cualquier proceso.
- Se agregan eventos de diagnóstico:
  - `profile_lease_waiting`
  - `profile_lease_acquired`
  - `profile_lease_released_after_cancel`
- Mientras espera el perfil, el agente cambia a estado `queued`; al adquirirlo vuelve a `running`.
- Durante una cancelación se omite el `state save` explícito posterior a matar los procesos. La sesión nombrada de `agent-browser` conserva su persistencia automática y se prioriza ejecutar `close`/`close --all` y liberar el perfil cuanto antes.

# Resultado esperado

Cancelar un agente que está esperando el navegador ya no puede bloquear la cola. Un agente lanzado después debe adquirir el perfil y continuar normalmente.

Si otro agente sigue usando activamente el perfil, los nuevos agentes pueden aparecer como `queued`, lo cual es intencional para evitar abrir simultáneamente el mismo perfil persistente de Chrome.

# Archivos modificados

- `src/browser/browser-runtime.ts`
- `README.md`
- `contexto/000-contexto-maestro.md`
- `contexto/75-corregir-deadlock-lease-agent-browser.md`
- `__tests__/browser-profile-lease.test.ts`

# Pruebas de regresión

- adquirir un primer lease;
- poner un segundo agente en cola;
- cancelar el segundo antes de que reciba el lease;
- crear un tercer agente;
- liberar el primero;
- verificar que el tercero recibe el lease y no queda en deadlock.

# Entrega

La entrega sigue siendo por reemplazo completo mediante ZIP. No se añaden scripts Python de eliminación.
