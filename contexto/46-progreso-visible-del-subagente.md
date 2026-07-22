# 46 — Progreso visible del subagente investigador

# Fecha

2026-07-16

# Objetivo

Garantizar que toda búsqueda web se ejecute dentro de un subagente con contexto aislado y mostrar al usuario avances reales de la investigación sin agregar retrasos artificiales.

# Decisiones tomadas

- El modelo principal solo recibe la herramienta `research_web`.
- `web_search` y `read_url` quedan disponibles exclusivamente dentro del contexto temporal del subagente.
- La evidencia intermedia, páginas leídas y resultados completos no se agregan al contexto persistente principal.
- El usuario recibe mensajes de progreso con la consulta, resultados encontrados, fuentes verificadas y estado de síntesis.
- WhatsApp mantiene el estado `composing` durante toda la operación mediante renovaciones periódicas.
- Cuando se utilizó el subagente no se agrega la espera artificial final de 3 a 5 segundos.
- Los errores al enviar un mensaje de progreso no cancelan la investigación.

# Arquitectura actual

- `src/research-agent.ts`: encapsula `web_search` y `read_url`, emite eventos de progreso y devuelve solo la síntesis final.
- `src/search/search-tools.ts`: ofrece una ejecución detallada con motor, cantidad y resultados normalizados para mostrar avances.
- `src/search/search-runtime.ts`: expone los resultados normalizados además del texto utilizado por el LLM.
- `src/messaging.ts`: mantiene el estado de escritura sin introducir retrasos.
- `src/bot.ts`: transforma los eventos del investigador en mensajes breves para WhatsApp.
- `src/ai.ts`: permite notificar cuando termina una ronda de herramientas y comienza el análisis de evidencia.

# Librerías usadas

- APIs ya disponibles de Bun/Node y Baileys.
- No se agregaron dependencias.

# Archivos importantes modificados

- `src/ai.ts`
- `src/bot.ts`
- `src/context.ts`
- `src/messaging.ts`
- `src/research-agent.ts`
- `src/search/search-runtime.ts`
- `src/search/search-tools.ts`
- `src/agent-config.ts`
- `README.md`
- `__tests__/research-agent.test.ts`
- `__tests__/search-runtime.test.ts`
- `__tests__/messaging.test.ts`

# Problemas encontrados

- Aunque existía `research_web`, el modelo principal también podía llamar directamente `web_search` y `read_url`.
- La notificación del subagente se enviaba después de terminar la herramienta, no al comenzar.
- El estado `composing` se activaba una sola vez y podía desaparecer durante investigaciones largas.
- Después de finalizar una investigación todavía se simulaban varios segundos de escritura.

# Soluciones implementadas

- Exposición exclusiva de `research_web` al modelo principal.
- Eventos de progreso del investigador: inicio, búsqueda, resultados, lectura, síntesis y finalización.
- Vista compacta de hasta cinco resultados con títulos y URLs; el resto se indica mediante contador.
- Renovación del estado `composing` cada ocho segundos hasta terminar.
- Envío inmediato de la respuesta final cuando la investigación ya mostró actividad real.
- Actualización del prompt para prohibir búsquedas directas desde el contexto principal.

# Pendientes

- Validar en una sesión real de WhatsApp cuánto tiempo permanece visible `composing` según el cliente utilizado.
- Ajustar la cantidad de resultados visibles si los mensajes de progreso resultan demasiado largos.
- Considerar una opción administrativa para desactivar mensajes detallados de progreso sin desactivar el investigador.

# Próximos pasos

- Ejecutar la suite con Bun y dependencias reales.
- Configurar un motor y probar una investigación estándar y otra profunda.
- Verificar que `context.json` solo conserve la consulta del usuario y la respuesta final.
