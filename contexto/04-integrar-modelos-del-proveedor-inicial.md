<!-- codewolf:auto-context:record -->
# 003 — Integrar modelos del proveedor inicial

# Fecha

2026-07-16

# Objetivo

Integrar modelos del proveedor inicial.

# Archivos importantes modificados

- .gitignore
- __tests__/commands.test.ts
- src/ai.ts
- src/bot.ts
- src/commands.ts
- src/context.ts
- src/index.ts

# Soluciones implementadas

- Conexión a un endpoint compatible con OpenAI mediante configuración externa
- Solo modelos con terminación -free: mimo-v2.5-free, hy3-free, nemotron-3-ultra-free, north-mini-code-free, etc.
- API key opcional (el provider no la requiere)
- hy3-free
- mimo-v2.5-free
- nemotron-3-ultra-free
- north-mini-code-free
- Cada usuario tiene su propio archivo JSON en contexts/<jid>.json

