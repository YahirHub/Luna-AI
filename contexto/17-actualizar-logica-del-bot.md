<!-- codewolf:auto-context:record -->
# 015 — Actualizar lógica del bot

# Fecha

2026-07-16

# Objetivo

Actualizar lógica del bot.

# Archivos importantes modificados

- __tests__/auth.test.ts
- src/auth.ts
- src/bot.ts

# Soluciones implementadas

- persistent/users.json como almacén de usuarios (contraseñas hasheadas con Bun.password argon2id)
- Sesiones activas en memoria (JID → username), sesión única por usuario
- Acciones pendientes por JID para flujos interactivos
- createAdmin(), addUser(), login(), banUser(), unbanUser(), userlist()
- Path inyectable para tests (no contamina datos reales)
- Creación de admin, duplicados, case-insensitive
- Login exitoso/fallido/baneado
- Sesión única, logout, getJid

