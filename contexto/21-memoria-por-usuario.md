# Cambio: Memoria persistente por usuario con estructura de carpetas por JID

## Objetivo técnico
Reestructurar la memoria persistente para que sea **por usuario** en lugar de global. Cada usuario (identificado por JID) tiene su propia carpeta `persistent/contexts/{safe_jid}/` con `context.json` (historial de chat) y `memory.md` (memoria persistente que sobrevive a `!clear`). El modelo escribe/lee su propia memoria mediante function calling, y el código enruta automáticamente al JID correspondiente.

## Archivos modificados

| Archivo | Cambio |
|---|---|
| `src/context.ts` | `contextFilePath` cambia de `{safe}.json` a `{safe}/context.json`. Nueva `getMemoryPath(jid)` exportada. `safeJid()`, `ensureUserDir()`. `getMemoryContent(jid)` y `makeSystemPrompt(jid)` aceptan JID. `loadContext` llama `ensureUserDir` + `memoryManager.init(jid)`. |
| `src/memory.ts` | Constructor acepta `testBaseDir` opcional. Métodos `init(jid)`, `getContent(jid)`, `write(jid, mode, content)`. `getPath(jid)` interno. `executeMemoryTool` acepta `jid` como 4º parámetro. `DEFAULT_MEMORY` ajustado a contexto por-usuario. |
| `src/bot.ts` | Eliminado `memoryManager.init()` global. Tool executor pasa `remoteJid` a `executeMemoryTool`. |
| `__tests__/memory.test.ts` | Tests con JID ficticio (`TEST_JID`, `OTHER_JID`). `createIsolatedMemory` usa `testBaseDir`. Nuevos tests de aislamiento entre JIDs. |

## Decisiones técnicas

- **Subcarpetas**: `persistent/contexts/{safe_jid}/context.json` y `persistent/contexts/{safe_jid}/memory.md`. Ambas rutas se resuelven en el mismo directorio base (`CONTEXTS_DIR`).
- **Sin migración retroactiva**: archivos planos `{safe}.json` existentes no se migran. El nuevo código crea subdirectorios. Los archivos legacy quedan huérfanos.
- **Sin dependencia circular**: `memory.ts` duplica la lógica `safeJid()` en lugar de importar de `context.ts`. Ambos usan `getAppDir()` de `utils.ts`.
- **template**: `DEFAULT_MEMORY` ajustado de "Memoria de Luna" (global) a "Memoria de esta conversacion" (por-usuario).
- **Init lazy**: `memoryManager.init(jid)` se llama dentro de `loadContext`, no al arrancar.

## Pruebas
- **97 tests, 0 fail** (16 memory + 27 auth + 22 commands + 9 media + 8 utils)
- Aislamiento verificado: contenido de JID-A no afecta JID-B
- `executeMemoryTool` con JID enruta correctamente
- TypeScript estricto sin errores
