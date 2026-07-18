# 60 — Modo oficial directo y filtrado estricto de precios

# Fecha

2026-07-17

# Objetivo

Aclarar y corregir el comportamiento observado cuando una investigación paralela de precios termina rápidamente aun sin motores de búsqueda configurados, y evitar que el extractor multiplique filas a partir de texto repetido de una sola página.

# Diagnóstico del log real

El registro mostró `providerOrder: []` y el mensaje de que no existían motores habilitados con API key. Por tanto, Tavily, Brave y los demás buscadores no participaron en esa ejecución.

La tarea no utilizó una caché de precios. Cada trabajador pasó a las URLs oficiales candidatas codificadas como puntos de recuperación y ejecutó `read_url` en tiempo real. Las páginas respondieron entre aproximadamente 0.4 y 2.6 segundos y los cuatro trabajadores se ejecutaron en paralelo, por lo que un informe podía completarse en pocos segundos.

El log también mostró 42 filas extraídas desde cinco lecturas oficiales. Esa cantidad era una señal de sobreextracción: el pipeline mezclaba tablas estructuradas, filas compactas y parser de prosa sobre el mismo contenido. Navegación, texto accesible y metadatos repetidos podían convertirse en filas adicionales.

# Correcciones

## Detección previa de buscadores

Se agregó `getWebSearchAvailability()` al runtime.

Antes de encolar una búsqueda de precios, el trabajador comprueba si existe al menos un proveedor habilitado con API key:

- con buscadores disponibles usa búsqueda y lectura;
- sin buscadores omite la cola y los reintentos;
- continúa directamente con documentación oficial;
- registra `research.search/skipped_no_provider` como advertencia controlada, sin stack de excepción repetido.

## Modo de descubrimiento explícito

Cada resultado guarda `discoveryMode`:

```text
search_and_fetch
direct_official
search_only
none
```

`result.json`, los logs, el Markdown y la respuesta final indican cuando los precios provinieron únicamente de lectura directa de páginas oficiales. Esto evita confundir una descarga rápida con una caché o con una búsqueda que nunca ocurrió.

## Filtrado estricto de filas

El extractor ahora:

1. prioriza tablas Markdown/HTML y filas compactas estructuradas;
2. solo usa el parser de prosa si no encontró una estructura confiable;
3. descarta `Modelo no identificado` y encabezados genéricos;
4. exige que el nombre coincida con el patrón del proveedor;
5. exige al menos precio de entrada o salida;
6. evita mezclar varias estrategias sobre la misma página y multiplicar resultados.

## Debug de datos reales

Se agregó el evento:

```text
research.pricing/extracted_rows
```

Muestra antes del PDF:

- modelo;
- precio de entrada;
- precio de caché;
- precio de salida;
- contexto y condiciones;
- URLs de origen;
- modo de descubrimiento.

También se corrigió la redacción de secretos para no ocultar nombres de archivo normales que contengan `api-`.

# Archivos modificados

```text
src/search/search-runtime.ts
src/research-agent.ts
src/research/pricing-extractor.ts
src/orchestration/parallel-research.ts
src/debug.ts
README.md
__tests__/pricing-extractor.test.ts
contexto/01-contexto-maestro.md
contexto/60-modo-directo-oficial-y-filtrado-de-precios.md
```

# Validación

- Compilación sintáctica de los módulos modificados con Bun aprobada.
- 131 pruebas relevantes aprobadas y 0 fallos.
- Incluye regresiones de alarmas, recordatorios, entregas programadas, confirmaciones, workdir, artefactos, investigación, cola de búsqueda y extractor de precios.
- Nuevas pruebas impiden que texto repetido multiplique filas y descartan modelos ajenos al proveedor.

# Prueba manual recomendada

1. Ejecutar la comparación sin motores configurados.
2. Confirmar `research.search/skipped_no_provider`.
3. Confirmar `discoveryMode: direct_official`.
4. Revisar `research.pricing/extracted_rows` y comprobar que las filas coincidan con el PDF.
5. Configurar Tavily u otro motor con `/setup-search` y repetir para confirmar `discoveryMode: search_and_fetch`.
