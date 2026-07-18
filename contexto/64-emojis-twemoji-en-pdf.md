# 64 — Emojis Twemoji vectoriales en PDF

# Fecha

2026-07-18

# Objetivo

Corregir la generación de PDF cuando el Markdown contiene emojis Unicode. El renderer anterior escribía texto usando fuentes PDF Type1 con codificación WinAnsi, por lo que los caracteres fuera de esa codificación terminaban convertidos a `?` aunque el Markdown original fuera correcto.

# Decisión

- Mantener el renderer PDF propio existente para no alterar tablas, orientación horizontal, paginación ni el empaquetado actual.
- Usar `@twemoji/parser` para detectar secuencias emoji completas dentro del texto Unicode.
- Renderizar los emojis como vectores Twemoji locales directamente dentro del stream PDF.
- Mantener el Markdown original sin transformaciones ni reemplazos persistentes.
- No depender de `Segoe UI Emoji`, `Noto Color Emoji` ni de otras fuentes instaladas en el sistema.

# Implementación

- Nueva dependencia: `@twemoji/parser` 15.0.0.
- Nuevos assets locales en `assets/twemoji/` con SVG Twemoji 15.
- Nuevo módulo `src/artifacts/twemoji.ts`:
  - separa texto y emojis mediante el parser;
  - conserva secuencias ZWJ y banderas como una sola unidad;
  - resuelve el SVG local por codepoint;
  - convierte paths, círculos y elipses SVG a operadores vectoriales PDF;
  - soporta comandos SVG de paths incluyendo líneas, curvas Bézier, cuadráticas y arcos;
  - soporta transformaciones `matrix`, `translate`, `scale` y `rotate` usadas por los assets;
  - usa un placeholder vectorial si un asset no está disponible, evitando volver a producir `?`.
- `src/artifacts/pdf.ts` ahora calcula anchos y saltos de línea teniendo en cuenta emojis y los dibuja inline tanto en párrafos como en encabezados y tablas.
- `scripts/package-runtime.ts` copia los assets Twemoji a `dist/runtime/twemoji` para que el binario compilado funcione igual en Windows, Linux y Docker.

# Compatibilidad

El PDF sigue siendo generado offline. Los emojis no requieren acceso a CDN ni conexión a Internet durante la generación.

El runtime busca assets en:

- `assets/twemoji` durante desarrollo;
- `runtime/twemoji` junto al ejecutable compilado;
- `dist/runtime/twemoji` durante pruebas/build local.

# Validación

- TypeScript: `bunx tsc --noEmit` correcto.
- Suite completa: 369 pruebas aprobadas, 0 fallos, 1027 verificaciones, 44 archivos de prueba.
- Se añadió regresión para `✅`, `🔥`, `👩‍💻` y `🇲🇽` en texto y tablas.
- Se recorrieron los 3720 SVG Twemoji incluidos y todos pudieron convertirse a comandos PDF sin excepción.
- Se generó y renderizó visualmente un PDF de prueba confirmando emojis a color en títulos, párrafos y tablas.
- El intento de bundle completo sin `prepare:media` no pudo finalizar porque el ZIP de trabajo no contenía los assets generados de Tesseract/OCR; no está relacionado con Twemoji. Los módulos modificados compilaron individualmente y la suite completa pasó.

# Archivos principales

- `src/artifacts/twemoji.ts`
- `src/artifacts/pdf.ts`
- `assets/twemoji/`
- `scripts/package-runtime.ts`
- `package.json`
- `bun.lock`
- `README.md`
- `__tests__/artifact-generation.test.ts`
- `__tests__/runtime-packaging.test.ts`
