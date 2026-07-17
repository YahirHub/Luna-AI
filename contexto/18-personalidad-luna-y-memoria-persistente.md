# Cambio: Personalidad Luna y memoria persistente con function calling

## Objetivo técnico
Dar personalidad mexicana amigable al bot (Luna) e implementar un sistema de memoria persistente (`persistent/memory.md`) que el modelo puede leer/escribir mediante OpenAI function calling (tools). La memoria sobrevive a `!clear`.

## Archivos modificados/creados

| Archivo | Cambio |
|---|---|
| `src/memory.ts` | **Creado.** MemoryManager (init/getContent/write), MEMORY_TOOLS definitions, executeMemoryTool |
| `src/ai.ts` | Agregados ToolDefinition/ToolCall types, rawChatRequest con normalización content→null, chatCompletionWithTools con multi-round tool loop (max 5) |
| `src/context.ts` | System prompt: Luna (mexicana, emojis, adaptable, incógnito), buildSystemPrompt inyecta memoria, setMemoryManager, refreshSystemPrompt, clearConversation preserva memoria |
| `src/bot.ts` | Import MemoryManager, instancia en initAi(), chatCompletionWithTools reemplaza chatCompletion, anuncia "📝 Escribiendo en memoria...", refreshSystemPrompt post-write |
| `__tests__/memory.test.ts` | **Creado.** 12 tests: init, getContent, append/overwrite write, executeMemoryTool read/write/unknown, tool definitions |
| `contexto/18-personalidad-luna-y-memoria-persistente.md` | Este archivo |

## Decisiones técnicas

- **Function calling**: Estándar OpenAI. `chatCompletionWithTools()` loop de hasta 5 rondas: tool_calls → ejecución → resultados.
- **Normalización null**: `rawChatRequest` convierte `content` a `null` en assistant messages con `tool_calls` (requisito OpenAI). El texto del modelo no se pierde porque no es respuesta final — es pensamiento del modelo.
- **Memoria única**: `persistent/memory.md` compartido entre todos los usuarios. `refreshSystemPrompt()` refresca el contexto activo. Los contextos cacheados inactivos se refrescan en su próximo `loadContext()`.
- **Persistencia**: La memoria sobrevive `!clear` porque `clearConversation()` regenera el system prompt desde `makeSystemPrompt()` que lee el archivo actual.

## Problemas conocidos

- Warnings de Bun (`ws.WebSocket`) no se pueden silenciar.
- Si el modelo no soporta function calling, las tools se ignoran.
- `!modelos` muestra modelos sin sufijo `-free` (decisión previa).

## Pruebas
- 94 tests, 0 fail (12 memory + 27 auth + 22 commands + 9 media + 8 utils).
- TypeScript estricto sin errores (`bun run typecheck`).
