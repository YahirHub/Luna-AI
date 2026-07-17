# 036 — Restaurar OpenCode Free como proveedor predeterminado

# Fecha

2026-07-16

# Objetivo

Corregir la regresión que obligaba a ejecutar `/setup-provider` antes de conversar y restaurar los modelos gratuitos de OpenCode como funcionamiento predeterminado, manteniendo el proveedor personalizado como override opcional.

# Decisiones tomadas

- Si no existe `persistent/llm.config.json`, Luna usa OpenCode Free automáticamente.
- Si el archivo personalizado es inválido, Luna registra el error y vuelve a OpenCode Free.
- `/setup-provider` es opcional y solo sustituye al proveedor integrado cuando el administrador completa el flujo.
- `/setup-provider gratis` elimina el override personalizado y reactiva OpenCode Free en caliente.
- El endpoint remoto de OpenCode es la fuente de verdad para el catálogo.
- En OpenCode Free solo se aceptan IDs terminados en `-free`.
- Si `/models` falla o no devuelve modelos gratuitos, se usa un catálogo local de emergencia.
- Los proveedores personalizados no aplican el filtro `-free`.
- Los límites de contexto de OpenCode Free se resuelven por coincidencia parcial del ID.
- Los modelos desconocidos usan límites conservadores de 120 000 tokens de contexto y 8 000 de salida.

# Arquitectura actual

- `src/providers/opencode-free.ts`: endpoints, modelo inicial, catálogo local, filtro y límites por modelo.
- `src/llm-config.ts`: guarda únicamente el proveedor personalizado y permite eliminarlo.
- `src/index.ts`: decide entre override personalizado y OpenCode Free.
- `src/bot.ts`: mantiene el modo activo, actualiza modelos y permite cambiar de proveedor en caliente.
- `src/models.ts`: consulta límites del módulo OpenCode Free y usa fallback conservador.

# Librerías usadas

- APIs nativas de Node/Bun.
- No se agregaron dependencias.

# Archivos importantes modificados

- `src/providers/opencode-free.ts`
- `src/models.ts`
- `src/bot.ts`
- `src/index.ts`
- `src/llm-config.ts`
- `__tests__/opencode-free.test.ts`
- `__tests__/llm-config.test.ts`
- `README.md`
- `contexto/000-contexto-maestro.md`
- `contexto/034-mascota-y-configuracion-llm.md`
- `contexto/035-configuracion-proveedor-desde-whatsapp.md`

# Problemas encontrados

- La corrección anterior eliminó el proveedor gratuito funcional y convirtió `/setup-provider` en requisito.
- Un mensaje normal devolvía una advertencia en lugar de usar los modelos gratuitos.
- El catálogo genérico había eliminado el filtro específico de OpenCode Free.
- Todos los modelos compartían el mismo límite de 120 000 tokens aunque sus capacidades eran diferentes.

# Soluciones implementadas

- Proveedor integrado creado como módulo independiente.
- Fallback automático sin archivo de configuración.
- Catálogo remoto filtrado por `-free` y catálogo local ante fallos.
- Modelo inicial `deepseek-v4-flash-free`.
- Límites conocidos para DeepSeek V4 Flash, MiMo V2.5, HY3, Nemotron 3 Ultra y North Mini Code.
- Comando administrativo para volver al modo gratuito sin editar archivos.
- README actualizado para instalación local y Docker.

# Pendientes

- Ejecutar integración real contra chat completions de OpenCode Free.
- Revisar periódicamente el catálogo local de emergencia porque los modelos gratuitos pueden cambiar.
- Confirmar los límites cuando OpenCode publique metadatos completos directamente en `/models`.

# Próximos pasos

- Ejecutar `bun run typecheck`, `bun test` y `bun run build`.
- Probar una instalación limpia sin `llm.config.json`.
- Confirmar que un mensaje normal responde sin solicitar `/setup-provider`.
- Probar `/setup-provider`, reinicio con volumen y `/setup-provider gratis`.
