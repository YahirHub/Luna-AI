<!-- codewolf:auto-context:record -->
# 003 — Integrar modelos gratuitos de OpenCode

# Fecha

2026-07-16

# Objetivo

Integrar modelos gratuitos de OpenCode.

# Archivos importantes modificados

- .gitignore
- __tests__/commands.test.ts
- src/ai.ts
- src/bot.ts
- src/commands.ts
- src/context.ts
- src/index.ts

# Soluciones implementadas

- Conexión a https://opencode.ai/zen/v1 configurable por.env
- Solo modelos con terminación -free: mimo-v2.5-free, hy3-free, nemotron-3-ultra-free, north-mini-code-free, etc.
- API key opcional (el provider no la requiere)
- hy3-free
- mimo-v2.5-free
- nemotron-3-ultra-free
- north-mini-code-free
- Cada usuario tiene su propio archivo JSON en contexts/<jid>.json

