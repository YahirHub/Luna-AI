# 62 — Runtime agéntico de investigadores y verificación independiente

# Fecha

2026-07-17

# Objetivo

Reemplazar el flujo de investigación paralela basado principalmente en extracción/pipeline por una arquitectura de agentes aislados similar conceptualmente a Codewolf: investigador con contexto propio y tools, verificador independiente, reintentos con feedback y revisión global del orquestador antes de generar artefactos.

# Problema observado

Los informes de precios podían marcarar un proveedor como `verificado` cuando únicamente se había abierto una página y un parser había producido alguna fila. Esto permitió que identificadores internos, columnas desplazadas o precios mal asociados llegaran al PDF.

El investigador tampoco era totalmente autónomo en comparativas de precios: gran parte de la lógica de búsqueda/extracción estaba codificada en el pipeline y no existía una segunda entidad que volviera a comprobar los datos antes de entregarlos al modelo principal.

# Arquitectura implementada

## Runtime genérico de agentes

Se añadieron:

- `src/agents/agent-types.ts`
- `src/agents/agent-runtime.ts`
- `src/orchestration/agent-spawner.ts`

Cada agente define:

- identificador y nombre;
- tools permitidas;
- contexto aislado;
- modo de salida;
- tool terminal de salida estructurada;
- número máximo de rondas.

El runtime administra directamente su historial `messages`, tool calls y resultados. Para salida estructurada no acepta una respuesta textual como terminación: el agente debe llamar su tool `submit_*`.

`spawnAgents` ejecuta agentes independientes con semántica equivalente a `Promise.allSettled`: el fallo de uno no cancela a los demás.

# Web Researcher

`WEB_RESEARCHER_AGENT` recibe una misión exacta sin historial del usuario.

Tools:

- `web_search`, cuando existe un motor configurado;
- `read_url`;
- `submit_research_result` como salida terminal.

El investigador puede ejecutar múltiples rondas de búsqueda y lectura. Los snippets no son evidencia. Cada hecho debe incluir URL abierta y fragmento literal de la fuente.

Para precios se exige que los hechos propuestos identifiquen el modelo y los importes demostrados. Los datos no resueltos se conservan como `unresolvedQuestions`.

# Research Verifier

Después de cada investigación se crea un nuevo agente `RESEARCH_VERIFIER_AGENT` con contexto independiente.

El verificador recibe:

- misión original;
- propuesta estructurada del investigador.

No recibe el historial interno del investigador ni confía en sus campos de estado/confianza.

Puede usar:

- `web_search`;
- `read_url`;
- `submit_verification`.

Debe volver a abrir las fuentes y entregar únicamente `verifiedFacts`.

# Guard determinista posterior al verificador

Un resultado `accept` del modelo verificador no es suficiente por sí solo.

Antes de aceptar cada fact se comprueba programáticamente:

- que la URL haya sido abierta por el propio verificador;
- que el fragmento de evidencia aparezca literalmente en el contenido leído;
- para precios, que el modelo tenga un nombre compatible con el proveedor;
- que el modelo esté marcado como activo;
- que existan precios positivos de entrada y salida;
- que ambos importes aparezcan dentro del fragmento literal citado.

Si falla cualquiera de estas comprobaciones, el fact se rechaza aunque el LLM haya respondido `accept`.

# Reintentos con feedback

Cada misión permite hasta tres intentos.

Flujo:

1. investigador;
2. verificador independiente;
3. guard determinista;
4. si se rechaza, los errores se convierten en feedback;
5. se crea un nuevo contexto de investigador;
6. se verifica nuevamente.

Un proveedor puede quedar `partial` o `failed` sin detener los demás.

# Revisión global del orquestador

Antes de generar Markdown/PDF el orquestador revisa todos los resultados:

- decisión del verificador;
- presencia de filas aprobadas;
- fuentes asociadas;
- input/output requeridos en informes de precios;
- modelos duplicados.

El resultado de esa fase se guarda en:

`tasks/<task-id>/synthesis/orchestrator-review.json`

El dataset canónico se guarda en:

`tasks/<task-id>/synthesis/dataset.json`

Solo ese dataset puede alimentar el informe final.

# Workdir por intento

Cada investigador conserva:

- `attempt-N/researcher-result.json`
- `attempt-N/researcher-conversation.json`
- `attempt-N/verification.json`
- `attempt-N/verifier-conversation.json`
- `result.json`
- `evidence.jsonl`

Los transcript persistidos son versiones compactas y no se agregan al contexto principal de WhatsApp.

# Progreso en WhatsApp

Se agregaron eventos para indicar:

- inicio del investigador;
- verificación independiente;
- reintento solicitado por el verificador;
- revisión global del orquestador;
- estado final del trabajador.

# Compatibilidad

- `parallel_research_report` continúa siendo la herramienta pública de alto nivel y terminal.
- `research_web` conserva su interfaz pública, pero internamente también usa investigador aislado, verificador independiente, guard determinista y reintentos antes de devolver resultados al modelo principal.
- alarmas y recordatorios no fueron modificados.
- TaskRuntime, workdir, PDF, ZIP, gitzip y envío por WhatsApp mantienen sus interfaces.

# Validación

Se añadieron pruebas que demuestran:

- rechazo del primer resultado de MiniMax y reintento con feedback;
- aceptación del segundo intento correcto;
- rechazo determinista de un `accept` del verificador cuando la evidencia citada no existe literalmente en la página abierta;
- verificación obligatoria también para `research_web` individual antes de devolver información al modelo principal;
- mantenimiento de la suite completa de alarmas y recordatorios.
