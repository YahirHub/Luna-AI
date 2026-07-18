# 58 — Extracción determinista de precios y bloqueo de PDF vacío

# Fecha

2026-07-17

# Objetivo

Corregir definitivamente las comparativas de precios que encontraban páginas y fragmentos útiles, pero terminaban generando un PDF sin importes porque la extracción final dependía de que el modelo devolviera correctamente una estructura JSON.

# Problemas encontrados

- La búsqueda y `read_url` podían funcionar, pero los precios seguían dependiendo de la respuesta estructurada del modelo.
- Algunas páginas oficiales renderizan las tablas con JavaScript o guardan sus datos dentro de JSON y scripts del framework.
- Varios sitios exponen filas compactas como `modelo$input$cache$output`, sin tuberías Markdown ni etiquetas repetidas.
- Las promociones pueden incluir primero el importe anterior tachado y después el precio vigente.
- Los fragmentos de resultados oficiales podían contener los precios exactos, pero se descartaban si el HTML de la página no era legible.
- El orquestador todavía podía generar un documento formal aunque ningún trabajador hubiera recuperado una sola fila con importes.
- La invitación pendiente para preguntar el nombre podía aparecer al final de una investigación, un archivo o una respuesta operativa.

# Soluciones implementadas

## Pipeline especializado de precios

Se agregó `src/research/pricing-extractor.ts`, separado de la síntesis del modelo. El extractor no contiene precios fijos y procesa exclusivamente la evidencia obtenida durante la tarea.

Puede recuperar:

- tablas Markdown completas;
- filas HTML convertidas a texto tabular;
- filas compactas sin separadores;
- frases con etiquetas de entrada, salida y caché;
- importes expresados por millón, por mil o por token;
- datos incrustados en JSON, Next.js, Docusaurus y scripts;
- fragmentos indexados cuando pertenecen al dominio oficial del proveedor.

Se incluyeron perfiles de recuperación para OpenAI, Anthropic, DeepSeek y MiniMax con dominios oficiales, URLs candidatas y patrones de nombres de modelo. Los perfiles no contienen importes y únicamente sirven para dirigir la búsqueda e interpretar el orden de columnas publicado por cada proveedor.

Cuando el usuario menciona solo al proveedor, la consulta de recuperación pide sus modelos API activos actuales e ignora nombres heredados que el modelo principal haya añadido sin que el usuario los solicitara. Una familia concreta solo limita la búsqueda cuando aparece en el nombre explícito del tema.

## Formatos compactos y descuentos

El parser reconoce estructuras como:

```text
gpt-5.6-sol$5.00$0.50$6.25$30.00
Claude Opus 4.5$5 / MTok$6.25 / MTok$10 / MTok$0.50 / MTok$25 / MTok
```

También conserva etiquetas `~~precio anterior~~` durante la conversión HTML y prefiere el importe vigente. Esto evita que una promoción de MiniMax termine usando el precio tachado.

Para DeepSeek se interpreta la estructura habitual de entrada con caché acertada, entrada sin caché y salida. Para OpenAI y Anthropic se separan entrada, caché y salida según los encabezados presentes en su documentación.

## Rescate desde fragmentos oficiales

Si una página dinámica no entrega contenido útil, el investigador conserva los fragmentos devueltos por el motor de búsqueda. Solo se aceptan para extraer precios cuando la URL coincide con un dominio oficial del proveedor. El resultado queda marcado como parcial si la página no pudo abrirse, pero los importes recuperados no se pierden.

Si el fragmento oficial ya contiene precios, el trabajador intenta abrir como máximo dos páginas para verificarlo y después continúa con el resultado parcial. El límite total es de cuatro lecturas por trabajador, evitando que diez páginas de 20 segundos excedan el timeout global de 120 segundos.

## Control de calidad del informe

Antes de generar el PDF, el orquestador cuenta las filas que contienen al menos un importe verificado.

Si el total es cero:

1. no genera PDF;
2. no envía un documento vacío por WhatsApp;
3. guarda un diagnóstico Markdown y JSON;
4. marca la tarea como fallida;
5. informa que no se obtuvieron precios verificables.

Si existe al menos una fila válida, genera la tabla con los datos recuperados y mantiene como parciales o fallidos los proveedores restantes.

## Cierre terminal y pregunta del nombre

Después de `parallel_research_report`, `chatCompletionWithTools` devuelve directamente el resultado confirmado de la herramienta. No realiza otra llamada al modelo, por lo que no puede iniciar una segunda investigación, contradecir el informe ni añadir una pregunta ajena.

También se agregó una guarda final que elimina una pregunta pendiente sobre el nombre cuando aparece al final de una respuesta operativa, investigación, archivo o ejecución de herramientas. La pregunta sigue permitida únicamente durante saludos o conversaciones casuales sin tareas pendientes.

# Archivos modificados

```text
src/research/pricing-extractor.ts
src/research-agent.ts
src/search/read-url.ts
src/orchestration/parallel-research.ts
src/ai.ts
src/bot.ts
src/context.ts
src/memory.ts
src/tool-confirmation.ts
README.md
__tests__/pricing-extractor.test.ts
__tests__/read-url.test.ts
__tests__/research-agent.test.ts
__tests__/workspace-agentic.test.ts
__tests__/tool-round-limit.test.ts
__tests__/tool-confirmation.test.ts
contexto/01-contexto-maestro.md
```

# Pruebas agregadas

- Extracción desde tablas oficiales normales.
- Extracción de filas compactas de OpenAI y Claude.
- Selección del precio promocional vigente de MiniMax en lugar del tachado.
- Interpretación del orden caché hit, caché miss y salida de DeepSeek.
- Recuperación desde fragmentos oficiales cuando la página dinámica falla.
- Rechazo de fragmentos secundarios no oficiales.
- Normalización de precios por mil tokens.
- Lectura de datos incrustados en Next.js.
- Conservación de precios tachados durante HTML a texto.
- Bloqueo de un PDF cuando no existe ninguna fila con importes.
- Generación y entrega cuando sí existen precios.
- Eliminación de la pregunta del nombre en respuestas operativas.
- Conservación de alarmas, recordatorios, entregas y confirmaciones.

# Pruebas manuales recomendadas

1. Repetir la solicitud de comparar DeepSeek, MiniMax, OpenAI y Anthropic.
2. Revisar cada `agents/<proveedor>/result.json` y confirmar que `pricing.items` contiene filas numéricas.
3. Simular el bloqueo de una página oficial y comprobar que un fragmento oficial con precios se conserva como resultado parcial.
4. Confirmar que no se genera PDF cuando todas las filas carecen de importes.
5. Pedir después el Markdown generado y comprobar que Luna no añade la pregunta del nombre.
6. Crear una alarma y un recordatorio para confirmar que no existe regresión.
