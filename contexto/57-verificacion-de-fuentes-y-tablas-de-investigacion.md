# 57 — Verificación de fuentes y tablas de investigación

# Fecha

2026-07-17

# Objetivo

Corregir la investigación paralela que podía declarar trabajadores terminados después de una búsqueda sin abrir páginas, generar informes de precios sin datos verificables y permitir que el modelo principal iniciara investigaciones secuenciales después de haber creado y enviado el PDF.

# Problemas encontrados

- `runResearchSubagent` consideraba suficiente haber llamado `web_search` y devolver cualquier texto.
- `read_url` sí estaba disponible, pero su uso dependía por completo de la decisión del modelo.
- El orquestador clasificaba un trabajador como correcto siempre que el texto no comenzara con `Error:`.
- No se comprobaba que una investigación de precios contuviera moneda, importes o unidad por millón de tokens.
- Después de `parallel_research_report`, el modelo principal conservaba todas las tools y podía iniciar varios `research_web` adicionales.
- La tabla final de precios dependía de Markdown libre generado por el sintetizador y podía quedar incompleta o mal estructurada.
- Las tablas anchas se dibujaban en página vertical y podían quedar demasiado comprimidas.

# Soluciones implementadas

## Investigador con fetch obligatorio

Se agregó `runResearchSubagentDetailed`, que conserva:

- búsquedas ejecutadas;
- resultados normalizados;
- páginas abiertas correctamente;
- errores de lectura;
- herramientas utilizadas;
- calidad final `complete`, `partial` o `failed`;
- incidencias que impidieron verificar el resultado.

Si el modelo llama `web_search` pero no llama `read_url`, el runtime ordena los resultados, prioriza fuentes oficiales y abre automáticamente las mejores páginas. La prioridad considera coincidencias del proveedor en el dominio, rutas de precios, documentación y API, y penaliza agregadores o blogs.

## Validación específica de precios

Para tareas de precios:

- se intentan abrir al menos dos fuentes por trabajador y se exige al menos una fuente legible con importes verificables;
- se extraen datos únicamente del contenido realmente descargado;
- la extracción devuelve una estructura JSON estable por modelo;
- los valores ausentes quedan como `null` y se muestran como `No verificado`;
- un trabajador solo queda `complete` cuando existe al menos un importe numérico verificable;
- si hay páginas abiertas pero faltan importes, queda `partial`;
- si no existe evidencia utilizable, queda `failed`.

Cada trabajador genera un Markdown tabular uniforme y guarda metadatos de las fuentes abiertas dentro de `result.json` y `evidence.jsonl`.

## Síntesis determinista para precios

Los informes de precios ya no delegan la forma de la tabla final a texto libre. El orquestador construye una tabla Markdown de seis columnas:

```text
Proveedor
Modelo
Entrada USD / 1M
Salida USD / 1M
Caché USD / 1M
Contexto y condiciones
```

Los caracteres `|` y saltos internos se limpian antes de crear las celdas. Los proveedores parciales o fallidos aparecen con `No verificado` en lugar de datos inventados.

## Herramienta terminal

`chatCompletionWithTools` admite `terminalTools`.

Cuando `parallel_research_report` termina correctamente:

1. se ejecuta antes que otras tools solicitadas en la misma ronda;
2. se omiten tools restantes de esa ronda;
3. se solicita una respuesta final sin herramientas;
4. no se permite iniciar después `research_web`, volver a generar el PDF ni reenviarlo.

## PDF para tablas anchas

`createPdfFromMarkdown` detecta el número de columnas. Las tablas de cinco o más columnas usan orientación horizontal de forma automática. También limita el número de líneas por celda para impedir filas desproporcionadas.

# Archivos modificados

```text
src/research-agent.ts
src/orchestration/parallel-research.ts
src/ai.ts
src/bot.ts
src/context.ts
src/artifacts/pdf.ts
README.md
__tests__/research-agent.test.ts
__tests__/tool-round-limit.test.ts
__tests__/artifact-generation.test.ts
contexto/01-contexto-maestro.md
```

# Pruebas

- Typecheck completo correcto.
- 341 pruebas aprobadas.
- 0 pruebas fallidas.
- 893 verificaciones.
- Se comprobó que un investigador abre automáticamente una fuente cuando el modelo no llama `read_url`.
- Se comprobó que una investigación de precios no queda completa sin importes verificables.
- Se comprobó que una tool terminal impide ejecutar `research_web` adicional.
- Se comprobó que tablas de seis columnas usan página horizontal.
- Se renderizó visualmente un PDF de prueba y la tabla quedó con celdas legibles, sin tuberías Markdown ni texto recortado.
- Las pruebas de alarmas, recordatorios, reintentos, entregas programadas y confirmaciones autoritativas permanecen aprobadas.

# Pruebas manuales recomendadas

1. Repetir la comparación de DeepSeek, MiniMax, OpenAI y Anthropic.
2. Confirmar que cada `result.json` incluya URLs abiertas y `contentChars` mayores que cero.
3. Confirmar que un proveedor sin precios accesibles aparezca como parcial o no verificado.
4. Confirmar que después de recibir el PDF no aparezcan nuevos mensajes de `AGENTE INVESTIGADOR`.
5. Abrir el PDF y revisar que la tabla de seis columnas esté en orientación horizontal.
