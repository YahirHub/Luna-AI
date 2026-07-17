<!-- codewolf:auto-context:record -->
# 004 — Implementar simulación de escritura

# Fecha

2026-07-16

# Objetivo

Implementar simulación de escritura.

# Archivos importantes modificados

- __tests__/commands.test.ts
- src/ai.ts
- src/bot.ts
- src/commands.ts
- src/context.ts

# Soluciones implementadas

- Función sendWithTyping(): activa composing → espera 3–5s aleatorio → envía mensaje → paused
- Se aplica a: respuestas de comandos, comandos no reconocidos, errores, imágenes guardadas, y respuestas AI
- En chat AI: composing durante la llamada API + 3–5s extra simulando que "escribe" la respuesta

