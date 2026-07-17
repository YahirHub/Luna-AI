<!-- codewolf:auto-context:record -->
# 032 — Actualizar proveedores y modelos

# Fecha

2026-07-16

# Objetivo

Actualizar proveedores y modelos.

# Archivos importantes modificados

- __tests__/compaction.test.ts
- src/alarm.ts
- src/compaction.ts
- src/context.ts
- src/models.ts
- src/reminder.ts
- src/utils.ts

# Soluciones implementadas

- ✅ Typecheck: 0 errors
- ✅ Tests: 196 pass, 0 fail
- Antes: 3 implementaciones idénticas de Intl.DateTimeFormat con America/Mexico_City en context.ts, reminder.ts, alarm.ts
- Después: getMexicoCityNow() única en utils.ts retorna {hour, minute, ymd, ts, dayOfWeek, text}
- getMexicoCityTime() en context.ts ahora es wrapper de 1 línea
- -60 líneas de código duplicado eliminado
- Antes: Math.ceil(text.length / 3) en ai.ts y compaction.ts
- Después: Solo en ai.ts, importado por compaction.ts

