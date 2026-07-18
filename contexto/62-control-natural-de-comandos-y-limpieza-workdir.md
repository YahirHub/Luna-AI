# 62 — Control natural de comandos y limpieza del workdir

# Fecha

2026-07-18

# Base del cambio

El usuario confirmó que el commit anterior ya fue realizado:

- Summary: `Reforzar resiliencia de búsquedas, LLM y WhatsApp`

Este registro documenta únicamente los cambios posteriores a ese commit.

# Objetivo

Permitir que las funciones ya expuestas mediante comandos del bot puedan ejecutarse también mediante lenguaje natural, manteniendo los filtros de rol existentes. No se exponen por lenguaje natural variables internas de resiliencia, reintentos, backoff ni límites operativos internos.

Agregar además un comando y una herramienta para limpiar por completo el workdir privado del usuario.

# Cambios implementados

## Herramientas de control para usuarios autenticados

Se agregó `src/control-tools.ts` con herramientas equivalentes a comandos funcionales de usuario:

- `control_help`
- `control_ping`
- `control_get_id`
- `control_cancel`
- `conversation_clear`
- `model_status`
- `model_list`
- `model_set`

Estas herramientas forman parte de `BASE_TOOLS`, por lo que están disponibles tanto para usuarios normales como para administradores autenticados.

## Herramientas administrativas de control natural

Solo cuando `isAdminSession(jid)` es verdadero se agregan las herramientas de administración global:

- `llm_provider_status`
- `llm_provider_use_opencode_free`
- `llm_provider_start_setup`
- `search_admin_status`
- `search_admin_set_enabled`
- `search_admin_set_default`
- `search_admin_set_fallback_order`
- `search_admin_test`
- `search_admin_start_set_api_key`
- `search_admin_remove_api_key`
- `agent_config_status`
- `agent_config_update`

Se mantienen además las herramientas administrativas existentes para usuarios y Whisper.

## Secretos fuera del LLM

La configuración natural de credenciales conserva el patrón seguro existente:

- Para proveedor LLM, `llm_provider_start_setup` inicia el mismo flujo seguro de `/setup-provider`.
- Para motores de búsqueda, `search_admin_start_set_api_key` inicia directamente la etapa segura de captura de la clave del proveedor elegido.
- La API key se solicita en el siguiente mensaje y no se pasa como argumento de herramienta al modelo.
- El mensaje sensible se intenta eliminar de WhatsApp después de procesarlo.
- La creación de usuarios continúa capturando la contraseña fuera del LLM.

## Configuración de búsqueda por lenguaje natural

El administrador puede ahora:

- Consultar estado de todos los motores.
- Activar/desactivar motores configurados.
- Cambiar el motor predeterminado.
- Cambiar el orden de fallback.
- Probar un proveedor o todos los activos.
- Iniciar captura segura de una API key.
- Eliminar una API key con confirmación explícita.

## Configuración funcional del agente por lenguaje natural

El administrador puede consultar y modificar las opciones equivalentes a `/config`:

- Acceso web del investigador.
- Subagente investigador activo/inactivo.
- Profundidad de búsqueda predeterminada.
- Timeout de seguridad del investigador.

No se agregaron tools para variables de reintentos, backoff, delays internos ni otros parámetros de resiliencia.

## Login, setup y cancelación natural local

Se agregó detección local de frases naturales para acciones que deben funcionar sin depender del proveedor LLM:

- Crear/configurar el primer administrador.
- Iniciar sesión.
- Cancelar/salir/abortar una operación interactiva.

Las credenciales continúan procesándose completamente fuera del modelo.

## Limpieza del workdir

`WorkspaceManager` incorpora `clearWorkdir(jid)`:

- Elimina todo el contenido de `workdir/` del usuario.
- Recrea `tasks/`, `inbox/` y `exports/`.
- Elimina el registro temporal de artefactos y tareas guardado dentro del workdir.
- No toca `context.json`, `memory.md`, recordatorios, alarmas, usuario ni configuraciones globales.

Se agregó la herramienta:

- `workspace_clear` con `confirmed=true` obligatorio.

Se agregaron los comandos:

- `!clear-workdir confirmar`
- `!limpiar-workdir confirmar`

La limpieza se rechaza mientras exista una tarea de subagentes en estado `running` o `synthesizing`.

# Seguridad y roles

- Usuarios normales reciben `USER_CONTROL_TOOLS` pero no `ADMIN_CONTROL_TOOLS`.
- Administradores reciben las herramientas de usuario, administración de usuarios, Whisper y control global.
- Las herramientas administrativas no se incluyen en el request LLM de un usuario normal.
- Las operaciones destructivas de limpieza del workdir, eliminación de API keys y restauración del proveedor requieren confirmación explícita.

# Archivos principales modificados

- `src/control-tools.ts`
- `src/bot.ts`
- `src/context.ts`
- `src/tool-confirmation.ts`
- `src/search/search-setup.ts`
- `src/workspace/workspace-manager.ts`
- `src/workspace/workspace-tools.ts`
- `README.md`
- `__tests__/control-tools.test.ts`
- `__tests__/workspace-agentic.test.ts`
- `__tests__/commands.test.ts`

# Validación

- `npx tsc --noEmit --pretty false`: correcto.
- Suite completa: 358 pruebas aprobadas, 0 fallos, 985 verificaciones, 44 archivos de prueba.
- Regresiones de alarmas, recordatorios, búsqueda multiproveedor, subagentes, reintentos LLM y cola resiliente de WhatsApp continúan aprobadas.

## Corrección posterior: captura natural de API keys sin quedar atrapado en menús

- La captura de API key iniciada por `search_admin_start_set_api_key` ahora es de una sola acción: al guardar la clave se cierra el estado interactivo y el siguiente mensaje vuelve al agente principal.
- El flujo numérico explícito de `/setup-search` conserva su comportamiento y vuelve al menú del proveedor después de guardar la clave.
- Las API keys enviadas dentro de frases naturales como `Esta es mi API key: ...` o `Este es el de exa.ai:...` se extraen localmente antes de persistirse; el texto completo ya no se guarda accidentalmente como clave.
- La misma normalización local se aplica a la API key del flujo `/setup-provider`.
- El flujo natural de configuración del proveedor LLM acepta URLs y el ID de modelo incluidos en frases como `El endpoint es https://...` o `Usa el modelo vendor/model`, además de API keys con prefijos conversacionales.
- La normalización de nombres de buscadores acepta alias habituales y el error tipográfico `fireclaw` como `firecrawl`, aunque internamente siempre se persiste el ID canónico.
- Se verificó que los demás controles naturales no dejan estados interactivos residuales al finalizar: modelos y configuración de agente son operaciones directas, Whisper usa tools directas, creación de usuario limpia su pending al completar y el proveedor LLM cancela su sesión al completar los cuatro pasos.

