<!-- codewolf:auto-context:record -->
# 001 — Actualizar implementación del proyecto

# Fecha

2026-07-16

# Objetivo

Actualizar implementación del proyecto.

# Archivos importantes modificados

- .gitignore
- README.md
- __tests__/commands.test.ts
- __tests__/media.test.ts
- __tests__/utils.test.ts
- package.json
- src/bot.ts

# Soluciones implementadas

- makeWASocket (default export) con printQRInTerminal: false
- useMultiFileAuthState para persistencia multiarchivo
- sock.requestPairingCode(numero) — método del socket, no standalone
- downloadMediaMessage(message, "buffer", {}) — 3 argumentos requeridos en v7
- sock.ev.on("creds.update", saveCreds) — guardado inmediato
- sock.ev.on("connection.update", update) — Partial<ConnectionState>
- sock.ev.on("messages.upsert", { messages, type }) — WAMessage[]
- DisconnectReason.loggedOut para detectar cierre definitivo

