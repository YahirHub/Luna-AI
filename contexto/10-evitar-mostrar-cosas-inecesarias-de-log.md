<!-- codewolf:auto-context:record -->
# 008 — Evitar mostrar cosas inecesarias de log

# Fecha

2026-07-16

# Objetivo

Evitar mostrar cosas inecesarias de log.

# Archivos importantes modificados

- src/bot.ts
- src/connection.ts
- src/index.ts

# Soluciones implementadas

- Al iniciar sin sesión: menú interactivo con readline
- Opción 1 (Teléfono): pide solo el número, agrega prefijo 521 internamente, muestra el código de vinculación coloreado (fondo cyan + texto bold negro)
- Opción 2 (QR): imprime el QR ASCII en terminal con printQRInTerminal: true
- Sesión existente detectada: salta el menú, conecta directo
- Logger de Baileys silenciado al nivel fatal con pino — adiós a los JSON de "connected to WA", "connection errored", etc.
- Solo se muestran los mensajes del bot con formato limpio y colores ANSI
- El endpoint del proveedor se configuraba internamente
- La API key era opcional mediante configuración externa

