# 71 — Configuración simplificada de proveedor LLM

## Fecha

2026-07-20

## Objetivo

Simplificar `/setup-provider` para que el administrador no tenga que conocer ni escribir endpoints internos de una API OpenAI-compatible.

## Cambios

- El flujo ahora solicita solo una URL base, por ejemplo `https://api.example.com/v1`.
- Luna deriva automáticamente `.../models` y `.../chat/completions`.
- Si el usuario pega por error una URL terminada en `/models`, `/chat/completions`, `/completions` o `/responses`, Luna recupera la URL base antes de continuar.
- Si se proporciona únicamente el origen, por ejemplo `https://api.example.com`, Luna prueba primero `https://api.example.com/v1/models` y después `https://api.example.com/models`.
- Tras recibir la API key, Luna consulta inmediatamente el catálogo de modelos. La API key puede omitirse respondiendo `sin-clave`.
- El catálogo acepta respuestas OpenAI estándar con `data[]`, además de `models[]`, listas directas y campos de identificador `id`, `model` o `name`.
- Los modelos detectados se muestran numerados y el administrador elige el modelo predeterminado enviando su número.
- La configuración no se guarda hasta que el catálogo haya respondido correctamente y se haya elegido un modelo válido.
- El estado del proveedor muestra la URL base en lugar de exponer por separado los endpoints derivados.

## Archivos principales

- `src/llm-config.ts`
- `src/ai.ts`
- `src/bot.ts`
- `__tests__/llm-config.test.ts`
- `__tests__/ai-models.test.ts`
- `README.md`

## Flujo final

1. `/setup-provider`
2. URL base del proveedor.
3. API key o `sin-clave`.
4. Consulta automática de `/models`.
5. Lista numerada de modelos.
6. Selección numérica del modelo predeterminado.
7. Persistencia de `chatCompletionsUrl`, `modelsUrl`, modelo y credencial.

## Compatibilidad

La estructura persistida de `persistent/llm.config.json` se conserva para no romper el runtime existente. Solo cambia y se simplifica el asistente de configuración.
