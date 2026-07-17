<!-- codewolf:auto-context:record -->
# 026 — Actualizar lógica del bot

# Fecha

2026-07-16

# Objetivo

Actualizar lógica del bot.

# Archivos importantes modificados

- __tests__/alarm.test.ts
- src/alarm.ts
- src/bot.ts
- src/context.ts

# Soluciones implementadas

- Tipo RecurringAlarm con id, jid, text, hour, minute, daysOfWeek, enabled, lastFiredDate, createdAt
- Clase AlarmManager con CRUD, checker cada 30s, persistencia por usuario en persistent/contexts/{jid}/alarms.json
- 4 tools: create_alarm, delete_alarm, list_alarms, toggle_alarm
- const CONTEXTS_DIR → export const CONTEXTS_DIR para que alarm.ts lo importe
- AlarmManager global, currentSock variable
- ALL_TOOLS incluye ALARM_TOOLS
- initAi() inicia alarmManager.startChecker(onAlarmDue)
- toolExecutor() maneja las 4 tools de alarmas

