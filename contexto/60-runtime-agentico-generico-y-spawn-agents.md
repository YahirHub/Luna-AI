# 60 — Runtime agéntico genérico y `spawn_agents`

## Fecha

2026-07-18

## Punto de partida

Este cambio parte del último estado real confirmado por el usuario, cuyo registro más reciente era `59-cola-busquedas-recuperacion-oficial-y-debug.md` y cuyo commit correspondía a **Corregir investigación paralela y extracción de precios**.

Los experimentos posteriores con verificadores obligatorios, guards por proveedor y pipelines rígidos de precios no forman parte de esta base.

## Objetivo

Reemplazar el flujo especializado que concentraba investigación, síntesis, PDF y entrega dentro de una sola herramienta por un runtime genérico de subagentes inspirado en la arquitectura observada en Codewolf.

El agente principal vuelve a actuar como orquestador real: decide qué investigaciones paralelizar, recibe únicamente los resultados finales de los subagentes, revisa si falta información y después continúa usando las herramientas normales para crear archivos, PDF o enviar artefactos.

## Arquitectura implementada

Se agregó `src/agents/` con:

- `agent-types.ts`: contratos comunes de agentes, solicitudes, resultados y eventos.
- `agent-registry.ts`: registro de definiciones y allowlist de agentes que el agente principal puede lanzar.
- `agent-runtime.ts`: ejecución aislada de un subagente con historial propio, herramientas restringidas, timeout y cancelación independiente.
- `agent-events.ts`: eventos de inicio, herramientas, finalización y error.
- `spawn-deduper.ts`: deduplicación semántica de solicitudes equivalentes dentro de una misma ronda de tools.
- `spawn-agents-tool.ts`: herramientas `spawn_agents` y `researcher_web`, persistencia de tareas y ejecución paralela con `Promise.allSettled`.
- `definitions/researcher-web.ts`: investigador web aislado inspirado en Codewolf.

## `researcher-web`

Características:

- No hereda el historial conversacional principal.
- Recibe únicamente una misión autocontenida.
- Solo puede usar `web_search` y `read_url`.
- No puede lanzar otros subagentes.
- No tiene acceso a memoria, alarmas, recordatorios, administración, WhatsApp ni herramientas de archivos.
- Puede iterar libremente entre búsquedas y lecturas hasta reunir evidencia suficiente.
- Los snippets de búsqueda se consideran descubrimiento de fuentes y no evidencia final.
- Prioriza fuentes primarias y evita repetir consultas equivalentes o leer dos veces la misma URL.
- Devuelve únicamente su último mensaje resumido al agente padre.

El timeout predeterminado es de 15 minutos por subagente. Es un techo de seguridad y no un objetivo de duración.

## `spawn_agents`

La herramienta principal puede recibir varias solicitudes independientes y ejecutarlas en paralelo.

Comportamiento:

1. Valida que `agent_type` esté permitido para el agente principal.
2. Normaliza y deduplica solicitudes semánticamente equivalentes.
3. Crea un contexto y `AbortController` independiente para cada agente.
4. Ejecuta las solicitudes únicas mediante `Promise.allSettled`.
5. Conserva resultados parciales aunque otro subagente falle.
6. Devuelve al agente principal un reporte compacto con estado y último mensaje de cada subagente.
7. No es una herramienta terminal: el loop del agente principal continúa después de recibir los resultados.

También existe `researcher_web` como alias directo para una sola investigación.

## Cancelación y timeouts

- Cada subagente tiene timeout independiente.
- La cancelación explícita de la tarea padre se propaga a todos los hijos.
- Un timeout o fallo de un subagente no cancela a los demás.
- Las herramientas web reciben la señal del subagente que las llamó.
- Se conserva la cola global existente para coordinar motores de búsqueda y evitar ráfagas/rate limits.

## Eventos y observabilidad

Cada subagente emite eventos estructurados para:

- inicio del agente;
- inicio de una tool;
- finalización de una tool;
- respuesta del agente;
- finalización;
- fallo.

En el workdir de la tarea se guarda por agente:

- `request.json`;
- `events.jsonl`;
- `result.md`;
- `result.json`.

Esto permite reconstruir una vista expandible similar a Codewolf sin inyectar todo ese detalle en el contexto del agente principal.

## Cambio de responsabilidad

El antiguo flujo especializado deja de controlar de extremo a extremo:

- investigación;
- verificación especializada por proveedor;
- síntesis;
- PDF;
- envío por WhatsApp.

Ahora el flujo esperado es:

1. Luna llama `spawn_agents` o `researcher_web`.
2. Los investigadores devuelven conocimiento resumido.
3. Luna principal revisa los resultados.
4. Si un resultado es insuficiente, Luna puede lanzar una investigación de seguimiento específica.
5. Luna sintetiza la información.
6. Luna usa `workspace_write_text` para crear Markdown.
7. Luna usa `create_pdf_from_markdown` cuando se pidió PDF.
8. Luna usa `whatsapp_send` para entregar el artefacto.

## Archivos especializados eliminados

Se retiraron del código activo:

- `src/research-agent.ts`;
- `src/research/pricing-extractor.ts`;
- `src/orchestration/parallel-research.ts`;
- pruebas específicas del pipeline anterior.

Se agregó `scripts/remove-legacy-research.py` para reproducir la eliminación de forma segura desde Windows.

## Límites del loop agéntico

- El agente principal usa hasta 64 rondas de herramientas por ejecución normal.
- `researcher-web` usa un máximo de 64 pasos.
- El límite interno global del runtime de chat permite hasta 200 rondas como protección contra loops.

Los límites son guardas de seguridad, no una expectativa de consumo.

## Compatibilidad conservada

Se mantuvieron sin cambios funcionales:

- `ReminderManager` y `executeReminderTool`;
- `AlarmManager` y `executeAlarmTool`;
- entregas programadas y reintentos;
- confirmaciones autoritativas;
- aislamiento por JID;
- workdir y artefactos;
- generación de PDF;
- ZIP y `gitzip`;
- envío de archivos por WhatsApp;
- búsqueda multiproveedor y su cola global;
- depuración completa en consola.

## Validación

- `npx tsc --noEmit --pretty false`: correcto.
- Suite de pruebas con Bun: **343 aprobadas, 0 fallos, 922 verificaciones, 41 archivos**.
- Las regresiones de alarmas y recordatorios permanecen aprobadas.
- Se agregaron pruebas de aislamiento del investigador, deduplicación, paralelismo real, resultados parciales, timeouts independientes y disponibilidad de herramientas.
