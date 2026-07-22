# 55 — Confirmación de herramientas, administración natural y timeout parcial

## Fecha

2026-07-17

## Objetivo

Evitar que Luna afirme que creó una alarma o recordatorio sin haber ejecutado y confirmado la herramienta correspondiente, mejorar el perfil inicial de memoria, permitir administración por lenguaje natural y conservar evidencia útil cuando el investigador alcanza su timeout.

## Problema observado

El historial podía contener afirmaciones del rol `assistant` como “tu alarma está configurada” aunque no existiera un resultado real de `create_alarm`. Además, los resultados de herramientas de recordatorios y alarmas se guardaban como mensajes `assistant`, mezclando hechos confirmados con texto generado por el modelo.

Un segundo caso permitía que, ante la queja “no creas ningún recordatorio”, el modelo interpretara mal la frase y llamara nuevamente `create_reminder`, creando un duplicado.

## Fuente de verdad de herramientas

Se agregó `src/tool-confirmation.ts`.

Reglas:

1. Solo un resultado exitoso de la herramienta correspondiente demuestra que la acción ocurrió.
2. Las mutaciones exitosas se guardan en el contexto como un mensaje `user` marcado:

```text
[Resultado de herramienta confirmado por el sistema]
Herramienta: create_reminder
Estado: ejecución confirmada por el sistema
...
```

3. Los resultados ya no se persisten como afirmaciones `assistant`.
4. Cuando `create_reminder` o `create_alarm` terminan con éxito, WhatsApp recibe un mensaje independiente:

```text
⚙️ CONFIRMACIÓN DEL SISTEMA

✅ ...
```

5. Si la respuesta final del modelo afirma que creó una alarma o recordatorio sin una confirmación del mismo tipo en esa ronda, la afirmación completa se suprime y se reemplaza por un estado autoritativo de acción no confirmada. No se muestra primero la alucinación.
6. Una confirmación de `create_reminder` no sirve como prueba de `create_alarm`, ni viceversa.
7. Un resultado exitoso de `list_reminders` o `list_alarms` permite describir el estado ya existente, pero nunca fingir una creación en la ronda actual.

## Negaciones y duplicados

Antes de ejecutar `create_reminder` o `create_alarm`, el orquestador revisa el mensaje actual. Expresiones como:

```text
no creas ningún recordatorio
no programes ninguna alarma
no quiero un recordatorio
```

bloquean la creación aunque el modelo haya intentado llamar la herramienta. Las quejas históricas como “no creaste el recordatorio”, “no me sale” o “no ejecutaste la herramienta” también bloquean una recreación automática; primero debe consultarse la lista. Solo se permite reintentar directamente cuando el usuario lo pide de forma inequívoca, por ejemplo “ahora sí créalo de nuevo”.

El prompt y las descripciones de herramientas indican que, cuando el usuario duda de una creación anterior, primero se debe llamar `list_reminders` o `list_alarms`. No se debe crear un duplicado salvo que el listado confirme que falta o que el usuario pida explícitamente recrearlo.

## Memoria inicial

El `memory.md` nuevo incluye:

```text
- Nombre: pendiente de preguntar
- Forma de trato preferida: pendiente de conocer
```

Luna debe preguntar el nombre de forma simpática cuando sea oportuno, sin interrumpir una petición urgente. Cuando el usuario confirme el nombre, debe guardarlo mediante `memory_write`. Nunca debe inventarlo ni deducirlo.

Este cambio solo afecta archivos `memory.md` creados después de la actualización. No se migran ni sobrescriben memorias existentes.

## Administración por lenguaje natural

Se agregó `src/admin-tools.ts`. Las herramientas solo se incorporan al contexto de un JID con sesión administradora.

### Usuarios

- `admin_list_users`
- `admin_start_add_user`
- `admin_ban_user`
- `admin_unban_user`

`admin_start_add_user` no recibe contraseñas. Inicia el flujo seguro existente y el siguiente mensaje se procesa fuera del LLM como contraseña. El bot intenta borrar ese mensaje de WhatsApp después de leerlo.

### Whisper

- `whisper_status`
- `whisper_list_models`
- `whisper_update_config`
- `whisper_download_model`
- `whisper_cleanup_models`

La descarga y la limpieza requieren confirmación explícita. Los usuarios normales no reciben estas herramientas.

## Timeout del investigador

`runResearchSubagent` conserva durante la ejecución:

- títulos;
- fragmentos;
- URLs encontradas;
- URLs que sí alcanzó a abrir.

Si el timeout ocurre después de obtener evidencia, devuelve una respuesta parcial claramente marcada, con fuentes y advertencia de que la investigación quedó incompleta. Solo devuelve un error de timeout cuando no existe ninguna evidencia utilizable.

## Archivos principales

Agregados:

```text
src/admin-tools.ts
src/tool-confirmation.ts
__tests__/admin-tools.test.ts
__tests__/tool-confirmation.test.ts
__tests__/tool-flow-source.test.ts
contexto/55-confirmacion-de-tools-administracion-natural-y-timeout-parcial.md
```

Modificados:

```text
src/bot.ts
src/context.ts
src/memory.ts
src/reminder.ts
src/alarm.ts
src/research-agent.ts
__tests__/memory.test.ts
__tests__/research-agent.test.ts
README.md
contexto/01-contexto-maestro.md
```

## Pruebas necesarias

1. Pedir una alarma y comprobar que WhatsApp reciba la confirmación separada del sistema.
2. Revisar `context.json` y confirmar que el hecho se guarde como `[Resultado de herramienta confirmado por el sistema]`.
3. Preguntar por la diferencia entre alarma y recordatorio sin haber creado una alarma y verificar que Luna no afirme que existe.
4. Enviar “no creas ningún recordatorio” y confirmar que `reminders.json` no cambie.
5. Dudar de una creación anterior y comprobar que Luna use el listado antes de recrear; una frase falsa del modelo debe desaparecer por completo, no mostrarse junto a una corrección.
6. Con un administrador, pedir en lenguaje natural listar usuarios y consultar/configurar Whisper.
7. Confirmar que un usuario normal no reciba herramientas administrativas.
8. Forzar un timeout de investigación después de una búsqueda y comprobar que se devuelvan resultados parciales.
9. Crear un sandbox de usuario nuevo y confirmar que Luna pregunte el nombre de forma natural.
