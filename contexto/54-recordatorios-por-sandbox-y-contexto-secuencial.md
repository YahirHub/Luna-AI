# 54 — Recordatorios por sandbox y numeración secuencial de contexto

## Fecha

2026-07-17

## Objetivo

Alinear los recordatorios con la persistencia por usuario ya utilizada por `context.json`, `memory.md` y `alarms.json`, y corregir la numeración duplicada de los documentos de `contexto/`.

## Persistencia resultante

Cada usuario dispone de un sandbox independiente:

```text
persistent/contexts/<jid>/
├── context.json
├── memory.md
├── reminders.json
└── alarms.json
```

`ReminderManager` recibe como directorio base `persistent/contexts`, escanea únicamente subdirectorios de usuario al iniciar y escribe solo los recordatorios del JID modificado.

## Decisión sobre datos locales anteriores

No se implementó una migración desde `persistent/reminders.json` hacia los sandboxes de usuario porque el proyecto continúa en pruebas locales y todavía no se ha publicado en producción.

El archivo global anterior:

```text
persistent/reminders.json
```

se ignora deliberadamente. Puede eliminarse manualmente en los entornos de prueba. Crear un `ReminderManager` no lo lee, no lo mueve y no crea archivos por usuario a partir de él.

## Aislamiento

- Crear un recordatorio para un usuario solo modifica su `reminders.json`.
- El listado y la eliminación usan los recordatorios del JID autenticado.
- El verificador periódico puede cargar todos los sandboxes para entregar recordatorios pendientes, igual que el gestor de alarmas.
- Las entregas pendientes y el estado `fired` se persisten en el sandbox propietario.

## Numeración de contexto

Todos los archivos de `contexto/` se renumeraron con una secuencia única y continua de dos dígitos:

```text
01-...
02-...
03-...
```

Se eliminaron prefijos ambiguos como `015-01`, `015-02` y números repetidos. Las referencias internas a nombres anteriores se actualizaron.

## Pruebas necesarias

1. Crear recordatorios para dos JID distintos y comprobar dos archivos separados.
2. Reiniciar el gestor y confirmar que carga ambos sandboxes.
3. Crear un `persistent/reminders.json` global y verificar que se ignore.
4. Marcar una entrega pendiente y confirmar que sobrevive al reinicio.
5. Listar y borrar recordatorios sin acceder a los de otro usuario.
6. Verificar que los nombres de `contexto/` sean únicos y secuenciales.
