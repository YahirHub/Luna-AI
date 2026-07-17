# 41 — Refactor de persistencia y entrega programada

# Fecha

2026-07-16

# Objetivo

Reducir duplicación y corregir fallos de consistencia en autenticación, contextos, memoria, recordatorios y alarmas sin cambiar la función principal del bot.

# Decisiones tomadas

- Mantener Bun, TypeScript, Baileys y la arquitectura modular existente.
- Aplicar el enfoque Ponytail: extraer solo responsabilidades repetidas o críticas.
- Centralizar escritura atómica y sanitización de rutas en `src/storage.ts`.
- No marcar recordatorios o alarmas como disparados hasta confirmar el envío por WhatsApp.
- Reintentar recordatorios fallidos hasta entregarlos y alarmas fallidas solo durante el día programado.
- Mantener un fallback de texto plano cuando falle el proveedor AI.
- Fijar la versión de Bun usada por desarrollo, Docker y CI.
- Conservar los registros históricos de `contexto/`, normalizando únicamente las numeraciones duplicadas con subíndices `01` y `02`.

# Arquitectura actual

- `src/bot.ts`: orquestación de comandos, autenticación y conversación.
- `src/messaging.ts`: envío de mensajes con presencia de escritura y limpieza garantizada.
- `src/scheduled-messages.ts`: generación y entrega común para recordatorios y alarmas.
- `src/storage.ts`: lectura JSON, sanitización de segmentos y reemplazo atómico de archivos.
- Managers de dominio: `auth.ts`, `context.ts`, `memory.ts`, `reminder.ts`, `alarm.ts`.

# Librerías usadas

- `@whiskeysockets/baileys` 7.0.0-rc13.
- `qrcode` 1.5.4.
- `pino` 10.3.1 como dependencia directa.
- Bun 1.3.14 y TypeScript 5.7.3.

# Archivos importantes modificados

- `src/storage.ts`
- `src/messaging.ts`
- `src/scheduled-messages.ts`
- `src/auth.ts`
- `src/context.ts`
- `src/memory.ts`
- `src/media.ts`
- `src/reminder.ts`
- `src/alarm.ts`
- `src/ai.ts`
- `src/bot.ts`
- `src/connection.ts`
- `src/index.ts`
- `package.json`
- `Dockerfile`
- `.github/workflows/build-release.yml`
- `README.md`
- `scripts/limpiar-archivos-innecesarios.ps1`

# Problemas encontrados

- Escrituras JSON directas susceptibles a archivos truncados ante cierres inesperados.
- Mutaciones podían quedar aplicadas solo en memoria cuando el guardado fallaba.
- Sesiones de usuarios baneados se guardaban antes de eliminarlas.
- Locks por JID permanecían indefinidamente en memoria.
- Checkers asíncronos podían solaparse.
- Recordatorios y alarmas podían marcarse como disparados aunque no hubiera socket o fallara también el fallback.
- Una entrega fallida podía quedar fuera de la ventana de comprobación después de un minuto.
- Mensajes persistidos inválidos podían volver a provocar payloads con contenido nulo.
- Comandos desconocidos podían listar nombres de comandos administrativos a usuarios normales.
- La ruta local de una imagen guardada se enviaba al usuario y el tamaño solo se confiaba al metadato remoto.
- Solicitudes AI no tenían timeout y reintentaban errores HTTP no recuperables.
- `pino` se importaba sin declararse como dependencia directa.
- `bun.lock` estaba ignorado y CI/Docker usaban una versión flotante de Bun.
- Faltaba una plantilla documentada de configuración del proveedor.
- Había numeración duplicada en los registros 015 y 018.

# Soluciones implementadas

- Persistencia atómica reutilizable con temporal y recuperación compatible con Windows.
- Validación básica de usuarios, sesiones y mensajes de contexto al cargar datos.
- Límite de 64 000 caracteres para memoria persistente.
- Validación de fechas reales y límite de 500 caracteres en recordatorios y alarmas.
- Eliminación de días duplicados en alarmas.
- Guardas contra ejecución concurrente de checkers.
- Entrega programada compartida con fallback y propagación real de errores de envío.
- Estado de entrega pendiente persistido antes de enviar: recordatorios hasta éxito y alarmas durante el mismo día.
- Reversión de mutaciones en memoria cuando falla el guardado de usuarios, sesiones, recordatorios o alarmas.
- Limpieza de socket al desconectar y reintento posible del código de vinculación.
- Timeout configurable del proveedor y reintentos solo para errores recuperables.
- Configuración externa del endpoint del proveedor.
- Script PowerShell con lista cerrada para eliminar únicamente artefactos generados, excluyendo `.git` y `persistent/`.
- Los logs de creación y entrega ya no incluyen el texto privado de recordatorios o alarmas.
- Las imágenes se validan también por tamaño real descargado, su identificador se sanitiza y la ruta local no se expone al chat.

# Pendientes

- Generar y versionar `bun.lock` ejecutando `bun install` en un entorno con acceso al registro.
- Añadir rate limit o backoff al flujo de login.
- Elevar gradualmente el mínimo de contraseña de 4 a 8 caracteres con una decisión de compatibilidad explícita.
- Dividir registros de comandos de `src/bot.ts` en módulos si el archivo continúa creciendo.
- Ejecutar pruebas de integración reales contra WhatsApp y el proveedor AI.

# Próximos pasos

- Ejecutar `bun install`, `bun run typecheck`, `bun test` y `bun run build`.
- Probar reconexión, baneo con reinicio, recordatorios con proveedor caído y permisos de disco restringidos.
- Confirmar el lockfile generado y cambiar CI/Docker a instalación congelada en una entrega posterior.
