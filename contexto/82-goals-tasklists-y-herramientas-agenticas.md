# 82. Goals, tasklists internas y herramientas agénticas

## Objetivo

Añadir a Luna una capa de autonomía de horizonte largo para trabajos que requieren planificar, investigar, crear o editar archivos, ejecutar código, verificar resultados y continuar hasta completar el objetivo sin bloquear la conversación principal.

## GoalRuntime

`src/goals/goal-runtime.ts` administra objetivos persistentes por JID. `/goal <objetivo>` y la tool `goal_start` registran un goal y liberan inmediatamente el chat. El runtime ejecuta iteraciones en segundo plano, usa tools permitidas por el registro modular y finaliza solo cuando un verifier independiente confirma que el objetivo está cubierto.

Estados: `queued`, `running`, `waiting_user`, `completed`, `failed`, `cancelled`, `interrupted`.

Los goals activos al reiniciar Luna pasan a `interrupted` y pueden reanudarse mediante `/goal reanudar` o `goal_resume`.

## Tasklist interna

La tasklist no tiene comando público. Es una herramienta interna persistente para el orquestador y GoalRuntime:

- `tasklist_create`
- `tasklist_read`
- `tasklist_replace`
- `tasklist_update`
- `tasklist_add`

Se almacena en `persistent/contexts/<jid>/goals/tasklists.json`, fuera del workdir editable. Un paso `completed` exige evidencia y solo se permite un paso `in_progress` por lista. El estado de goals se conserva en `persistent/contexts/<jid>/goals/goals.json`.

## Verificación y continuación

El GoalRuntime combina dos verificaciones:

1. Validación determinista: la tasklist debe ser específica, tener al menos dos pasos y no contener pasos `pending`, `in_progress` o `blocked`.
2. Verifier LLM independiente: comprueba objetivo, evidencia de tasklist, tool results, archivos y validaciones realizadas. Para código exige pruebas/build/sintaxis cuando sean razonablemente posibles; para investigación exige evidencia obtenida de fuentes o subagentes.

Si la verificación falla, los huecos se convierten en nuevos pasos y el goal continúa. Se limita el número de iteraciones y el runtime se detiene tras varias iteraciones sin progreso verificable para evitar loops infinitos.

## Herramientas agénticas de workdir

Se añaden:

- `workspace_mkdir`
- `workspace_stat`
- `workspace_move`
- `workspace_copy`
- `workspace_glob`
- `workspace_search`
- `workspace_read_files`
- `workspace_apply_patch`
- `workspace_runtime_status`
- `workspace_exec`

Se mantienen las tools existentes de lectura/escritura/append/edición/eliminación y artefactos.

`WorkspaceManager.resolvePath` valida también el ancestro existente más cercano al crear rutas nuevas, cerrando escapes del tipo `symlink-externo/nuevo-archivo`. `tasks.json` y `artifacts.json` son metadata reservada del runtime y no pueden manipularse mediante tools de usuario.

## Ejecución de Bash, Python, Node y Bun

`workspace_exec` detecta los runtimes instalados y solo permite ejecutar los disponibles. Tiene timeout, límite de salida y cancelación del árbol de procesos.

En Linux la ejecución exige Bubblewrap operativo. El sandbox crea namespaces de usuario/PID/mount, presenta los directorios del runtime como solo lectura, monta únicamente el workdir del JID como escritura, usa `/tmp` efímero y conserva red para instalar dependencias o consultar servicios externos. Si Bubblewrap o los namespaces no funcionan, Luna rechaza la ejecución en lugar de degradar silenciosamente a una terminal sin aislamiento.

La imagen Docker instala Bash, Bubblewrap, Python 3/pip/venv, Node.js/npm y Git. Bun puede utilizarse si está disponible en el runtime en el que se ejecuta Luna.

## Investigación dentro de un goal

Un goal puede ejecutar `spawn_agents` de forma síncrona respecto del propio GoalRuntime (`background=false`) porque el GoalRuntime ya está desacoplado del chat. Esto permite el patrón:

1. detectar falta de documentación;
2. delegar a `researcher-web` cuando api-search está disponible o `browser-web` en caso contrario;
3. esperar el handoff del investigador;
4. continuar la implementación;
5. investigar nuevamente si todavía hay huecos;
6. ejecutar pruebas y corregir hasta superar el verifier.

El `AbortSignal` del goal se propaga a la tarea de subagentes. `/cancelar` o `goal_cancel` detienen también los descendientes y procesos de terminal.

## Recursos visuales sin visión

El prompt de `browser-web` incluye un flujo para Wikimedia Commons. Cuando una tarea requiere imágenes o recursos visuales y el modelo no tiene visión, el agente debe preferir páginas `File:` de Commons, conservar descripción textual, autor, licencia, fuente y URL de archivo, y no inferir contenido visual sin evidencia textual. Si el recurso se reutiliza, debe conservar metadata de atribución/licencia cuando esté disponible.

## Seguridad

- Todo sigue requiriendo sesión autenticada.
- El registro modular continúa filtrando tools por rol y disponibilidad.
- GoalRuntime no recibe `goal_start`, evitando goals anidados.
- La tasklist y goals se guardan fuera del workdir editable.
- No se permite `workspace_clear` dentro de un goal.
- No se permite salir del workdir mediante rutas absolutas, traversal o symlinks.
- La terminal falla cerrada si el aislamiento no puede establecerse.
- El goal no debe realizar push, despliegues, pagos o acciones externas irreversibles salvo autorización explícita del objetivo del usuario.
