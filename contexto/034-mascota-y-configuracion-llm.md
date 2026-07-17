# 034 — Mascota y configuración LLM independiente

> Estado: decisiones de proveedor sustituidas por `035-configuracion-proveedor-desde-whatsapp.md` y `036-restaurar-opencode-free.md`.

# Fecha

2026-07-16

# Objetivo

Integrar la identidad visual de Luna AI y separar por completo la configuración del proveedor LLM del código y de las variables de entorno.

# Decisiones tomadas

- Usar `assets/luna-ai.png` como mascota oficial mostrada en el README.
- Cargar el proveedor desde `llm.config.json` en tiempo de ejecución.
- Decisión inicial: versionar `llm.config.example.json`. Esta plantilla fue eliminada posteriormente por el flujo `/setup-provider`.
- Usar endpoints completos para chat completions y listado de modelos.
- Para proveedores personalizados, no filtrar por sufijo; el endpoint configurado es la fuente de verdad.
- Para el proveedor integrado OpenCode Free, filtrar exclusivamente IDs `-free`; consultar el registro 036.
- Mantener `defaultModel` como modelo inicial de chats nuevos.
- Conservar el modelo ya persistido en chats existentes.
- Si el endpoint de modelos falla o devuelve vacío, usar únicamente `defaultModel`.

# Arquitectura actual

- `src/llm-config.ts`: lectura, validación y selección de ruta del archivo LLM.
- `src/ai.ts`: solicitudes al endpoint de chat y descubrimiento de modelos sin filtros por nombre.
- `src/bot.ts`: fallback de catálogo, selección con `!modelos` y modelo inicial.
- `src/context.ts`: persiste la selección individual por JID.

# Librerías usadas

- Solo APIs nativas de Node/Bun para JSON, rutas, URLs y archivos.
- No se agregaron dependencias.

# Archivos importantes modificados

- `assets/luna-ai.png`
- `README.md`
- `llm.config.example.json`
- `.gitignore`
- `src/llm-config.ts`
- `src/ai.ts`
- `src/bot.ts`
- `src/context.ts`
- `src/index.ts`
- `src/scheduled-messages.ts`
- `__tests__/llm-config.test.ts`
- `__tests__/ai-models.test.ts`
- `.github/workflows/build-release.yml`

# Problemas encontrados

- El proveedor estaba acoplado a una URL predeterminada específica.
- La API key y el timeout dependían de variables de entorno dispersas.
- El catálogo descartaba cualquier modelo que no terminara en `-free`.
- El primer modelo devuelto por el proveedor reemplazaba el modelo inicial.
- Si `/models` fallaba, `!modelos` no permitía continuar con una opción segura.

# Soluciones implementadas

- Configuración JSON validada con endpoints completos, API key, modelo predeterminado y timeout.
- Parámetro opcional `--llm-config` para usar otra ruta.
- Catálogo sin filtrado por sufijos o nombres.
- Modelo predeterminado incluido siempre como primera opción.
- Fallback automático al modelo predeterminado ante error o catálogo vacío.
- Solución inicial: plantilla genérica sin proveedores concretos.
- Estado actual: la plantilla y su inclusión en releases fueron eliminadas; consultar el registro 035.

# Pendientes

- Ejecutar pruebas con Bun y un proveedor real compatible.
- Confirmar si proveedores no compatibles con el formato `{ data: [{ id }] }` requieren adaptadores explícitos.

# Próximos pasos

- Este flujo manual quedó obsoleto.
- Crear o reemplazar la configuración desde WhatsApp con `/setup-provider`.
- Ejecutar `bun run typecheck`, `bun test` y `bun run build`.
- Probar `!modelos` con el endpoint disponible y fuera de servicio.

# Actualización posterior

La creación manual descrita en este registro fue reemplazada por el flujo administrativo documentado en `contexto/035-configuracion-proveedor-desde-whatsapp.md`.

- `llm.config.example.json` fue eliminado por ser innecesario.
- La ruta predeterminada pasó a `persistent/llm.config.json`.
- El archivo se genera desde WhatsApp con `/setup-provider`.
- La ausencia o corrupción del archivo ya no impide iniciar ni vincular WhatsApp.
- Docker persiste la configuración mediante el mismo volumen de `persistent/`.
