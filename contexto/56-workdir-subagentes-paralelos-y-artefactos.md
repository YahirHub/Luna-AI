# 56 — Workdir, subagentes paralelos y artefactos

# Fecha

2026-07-17

# Objetivo

Agregar capacidades agénticas directas sin MCP ni SSH: workdir aislado por usuario, investigación paralela con subagentes, archivos físicos, PDF, ZIP, gitzip y devolución de artefactos por WhatsApp, preservando la lógica existente de alarmas y recordatorios.

# Decisiones

- MCP y SSH quedan fuera de este cambio.
- Alarmas y recordatorios conservan sus gestores, tools, archivos por JID, reintentos y confirmación autoritativa existentes.
- Cada usuario tiene un `workdir` propio bajo `persistent/contexts/<jid>/workdir`.
- Cada tarea paralela crea una carpeta independiente con áreas para agentes, síntesis, artefactos y temporales.
- Los investigadores solo reciben búsqueda y lectura web; no pueden usar memoria, WhatsApp, alarmas, recordatorios ni administración.
- Una investigación continúa cuando uno o varios trabajadores fallan y el informe final marca los datos no verificados.
- Para comparativas de dos o más temas, el modelo principal debe usar una sola llamada a `parallel_research_report` en lugar de ejecutar `research_web` repetidamente.
- `parallel_research_report` ya crea y entrega el PDF por defecto; no deben repetirse `create_pdf_from_markdown` ni `whatsapp_send` para el mismo informe.

# Implementación

## Workdir

Se agregaron:

```text
src/workspace/workspace-manager.ts
src/workspace/workspace-tools.ts
```

Funciones principales:

- aislamiento por JID;
- rutas relativas obligatorias;
- rechazo de `..`, rutas absolutas y enlaces simbólicos externos;
- creación de tareas y carpetas estándar;
- lectura y escritura de texto y binarios;
- registro persistente de artefactos;
- listado y eliminación controlada.

## Tareas y subagentes paralelos

Se agregaron:

```text
src/orchestration/task-runtime.ts
src/orchestration/parallel-research.ts
```

`parallel_research_report` acepta entre dos y ocho temas y ejecuta hasta cuatro investigadores concurrentes. Cada trabajador crea `request.json`, `result.json`, `evidence.jsonl` y un Markdown físico. La síntesis conserva además `synthesis/result.json` y su Markdown antes de copiar los artefactos finales. Se usa un resultado equivalente a `allSettled`: los fallos se registran, pero no cancelan la síntesis restante. El resultado final genera Markdown y PDF y puede enviarse automáticamente al mismo JID.

Se agregaron también `task_list`, `task_status` y `task_cancel`. `/cancelar` aborta la tarea activa mediante `AbortController`; la señal se propaga hasta cada investigador, las búsquedas, las lecturas web y las llamadas LLM, sin confundir una cancelación del usuario con un timeout parcial.

## Extracción web

`src/search/read-url.ts` produce contenido Markdown optimizado, preservando encabezados, listas, enlaces y tablas, manteniendo las protecciones SSRF, DNS, redirecciones, tamaño y timeout existentes.

## PDF

`src/artifacts/pdf.ts` interpreta bloques Markdown y dibuja las tablas como tablas PDF reales:

- celdas y bordes;
- encabezado diferenciado;
- ajuste de texto por columna;
- anchos distribuidos según el contenido;
- repetición del encabezado al cambiar de página;
- encabezados, listas, citas, reglas y bloques de código;
- numeración de páginas;
- soporte WinAnsi para texto en español.

Las líneas con `|` ya no se imprimen literalmente cuando forman una tabla Markdown válida.

## ZIP y gitzip

Se agregaron:

```text
src/artifacts/zip.ts
src/artifacts/artifact-tools.ts
```

Capacidades:

- `archive_folder` para carpetas completas;
- `gitzip` con `.gitignore` raíz y anidados, negaciones, exclusión de `.git/` y enlaces simbólicos;
- advertencias por nombres de posibles secretos;
- creación automática de carpetas de salida.

## WhatsApp

Se agregó:

```text
src/tools/whatsapp-tools.ts
```

`whatsapp_send` solo envía al mismo JID. Usa imagen, audio o video nativo hasta 10 MiB; por encima de ese tamaño usa documento. Las carpetas se comprimen primero y las entregas quedan registradas como artefactos.

## Cierre después del límite de tools

`src/ai.ts` ya no devuelve el mensaje `El modelo excedió el número de llamadas a herramientas` después de una última acción exitosa.

Al agotarse el presupuesto de rondas:

1. conserva todos los resultados de las herramientas ejecutadas;
2. hace una solicitud final sin herramientas para que el modelo redacte el cierre;
3. si esa solicitud falla, devuelve el último resultado real de herramienta en vez de un error falso;
4. admite hasta ocho rondas por defecto y un máximo interno de dieciséis.

# Integración principal

Se modificaron:

```text
src/ai.ts
src/bot.ts
src/context.ts
src/tool-confirmation.ts
src/artifacts/pdf.ts
src/orchestration/parallel-research.ts
README.md
contexto/01-contexto-maestro.md
```

Las herramientas nuevas se agregan sin reemplazar los bloques de `executeReminderTool` ni `executeAlarmTool`.

# Pruebas

Se mantienen las pruebas de workdir, orquestación, ZIP, WhatsApp, alarmas y recordatorios. Se agregaron verificaciones para:

- tablas PDF sin tuberías Markdown literales;
- cierre final después de alcanzar el máximo de rondas de tools;
- fallback al último resultado de herramienta si el proveedor falla durante el cierre;
- selección preferente de la tarea paralela para comparativas;
- ausencia de integraciones retiradas.

# Pruebas manuales pendientes

1. Ejecutar una investigación paralela real con varios motores de búsqueda.
2. Forzar el fallo de un trabajador y confirmar el informe parcial.
3. Abrir un PDF con una tabla ancha y verificar celdas, ajuste de texto y saltos de página.
4. Enviar PDF, imagen, video mayor de 10 MiB y carpeta.
5. Probar `gitzip` sobre un proyecto real con `.gitignore` anidados.
6. Crear y entregar alarmas y recordatorios antes y después de reiniciar el proceso.

# Fuera de alcance

- SSH;
- MCP;
- terminal local o remota;
- instalación de paquetes;
- agente programador;
- navegador automatizado;
- envío de WhatsApp a terceros.
