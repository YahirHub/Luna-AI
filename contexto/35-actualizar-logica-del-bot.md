<!-- codewolf:auto-context:record -->
# 027 — Actualizar lógica del bot

# Fecha

2026-07-16

# Objetivo

Actualizar lógica del bot.

# Archivos importantes modificados

- __tests__/compaction.test.ts
- src/ai.ts
- src/bot.ts
- src/compaction.ts
- src/context.ts
- src/models.ts

# Soluciones implementadas

- ✅ Typecheck — 0 errores
- ✅ Tests — 192 de 192 (0 fallos), 356 expect() calls
- handleMessage → handleAiChat
- withLock(remoteJid) → addMessage → ensureContextCompaction
- ensureContextCompaction:
- Construir apiMessages con contexto dinámico (hora + memoria + resumen compactado)
- chatCompletionWithTools → respuesta
- Liberar lock

