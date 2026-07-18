# 61 — Coherencia de artefactos y parser estricto de precios

# Fecha

2026-07-17

# Problema observado

Una comparativa de precios generó un PDF con filas que no eran modelos, importes desplazados entre columnas, servicios de audio o imagen y modelos retirados. Después, al pedir el contenido completo del PDF, el modelo reconstruyó una respuesta desde el contexto en lugar de leer el archivo fuente, por lo que ocultó filas defectuosas y modificó cifras.

# Causa

- El extractor genérico recorría demasiado texto accesible y asociaba cualquier secuencia de importes cercana a un nombre o encabezado.
- Las tablas compactas de cada proveedor tienen órdenes de columnas distintos.
- La investigación podía marcar un proveedor como verificado por haber abierto una URL, aunque las filas extraídas no representaran correctamente la tabla.
- El seguimiento de un PDF volvía a pasar por el LLM y no estaba unido de forma autoritativa al Markdown utilizado para renderizarlo.

# Solución implementada

- Se agregaron parsers estrictos para las páginas oficiales de DeepSeek, MiniMax, OpenAI y Anthropic.
- DeepSeek interpreta la tabla columnar de caché hit, caché miss y salida por posición de modelo.
- MiniMax limita la extracción a la sección LLM activa, separa Standard y Priority, conserva los niveles por longitud de contexto y excluye Legacy, Audio, Video y otros productos.
- OpenAI limita la extracción a Flagship models, procesamiento Standard y contexto corto; respeta columnas vacías y excluye Batch, Flex, Priority, multimodal, audio e imágenes.
- Anthropic interpreta las cinco columnas de la tabla de modelos, usa cache hit y output correctos, excluye filas deprecated o retired y evita duplicar un precio futuro cuando existe el precio vigente.
- Los fragmentos de los buscadores sirven únicamente para descubrir URLs. Nunca vuelven a ser evidencia numérica.
- Toda fila exige un modelo canónico del proveedor, precio positivo de entrada y salida y una URL oficial de pricing abierta.
- El PDF queda registrado junto con su `sourcePath` Markdown.
- Las solicitudes como “dame el contenido completo del PDF” leen y envían el Markdown exacto asociado sin llamar al modelo ni reinterpretar cifras.

# Archivos principales

- `src/research/pricing-extractor.ts`
- `src/research-agent.ts`
- `src/orchestration/parallel-research.ts`
- `src/workspace/workspace-manager.ts`
- `src/workspace/workspace-tools.ts`
- `src/workspace/artifact-followup.ts`
- `src/bot.ts`
- `src/context.ts`
- `__tests__/pricing-extractor.test.ts`
- `__tests__/research-agent.test.ts`
- `__tests__/workspace-agentic.test.ts`

# Validación

- 357 pruebas aprobadas en 40 archivos, excluyendo únicamente `media.test.ts` porque el paquete entregado no contiene `node_modules` y el entorno no dispone de `@whiskeysockets/baileys`.
- Se compilaron de forma independiente los módulos modificados y `src/bot.ts` con Bun usando dependencias externas.
- Se generó y renderizó un PDF de dos páginas con filas estrictas; no contiene encabezados como modelos, precios desalineados ni productos no textuales.
- Las pruebas completas de alarmas, recordatorios, entregas programadas y confirmaciones permanecen aprobadas.

# Regla permanente

El contenido de un artefacto generado es autoritativo. Luna no debe reconstruirlo desde memoria ni cambiar cifras al describirlo. Para precios, abrir una fuente no equivale por sí solo a verificar una fila: el parser debe validar modelo, columnas, unidad y origen.
