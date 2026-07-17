# 035 — Configuración del proveedor desde WhatsApp

> Estado: corregido por `036-restaurar-opencode-free.md`; `/setup-provider` es opcional y no reemplaza el proveedor gratuito integrado cuando falta configuración.

# Fecha

2026-07-16

# Objetivo

Eliminar la configuración manual duplicada y permitir que el administrador configure o reemplace el proveedor LLM directamente desde el bot mediante `/setup-provider`, incluyendo instalaciones Docker con vinculación QR.

# Decisiones tomadas

- Decisión original: iniciar y vincular WhatsApp sin LLM. Corrección posterior: iniciar con OpenCode Free automáticamente.
- Solo una sesión administradora puede ejecutar `/setup-provider`.
- El asistente solicita cuatro datos: URL de chat completions, URL de modelos, modelo predeterminado y API key.
- `sin-clave` representa un proveedor que no requiere autenticación.
- La configuración se guarda automáticamente en `persistent/llm.config.json`.
- La configuración se aplica en caliente sin reiniciar el proceso.
- El timeout permanece en 60 segundos por defecto y conserva el valor previo al reconfigurar.
- El catálogo no filtra modelos por nombre, precio, proveedor ni sufijo.
- Si el catálogo falla o queda vacío, se usa el modelo predeterminado.
- Los chats existentes conservan su modelo; los nuevos usan el predeterminado actualizado.
- El mensaje que contiene la API key se intenta eliminar de WhatsApp después de leerlo.
- `llm.config.example.json` se elimina porque ya no forma parte del flujo de instalación.

# Arquitectura actual

- Estado corregido: `src/index.ts` carga el override si existe; si falta o es inválido, activa OpenCode Free.
- `src/llm-config.ts` valida, guarda atómicamente y administra el estado temporal de `/setup-provider`.
- `src/bot.ts` contiene el comando administrativo, aplica la configuración en caliente y actualiza el catálogo.
- `src/context.ts` permite cambiar el modelo predeterminado sin sobrescribir selecciones persistidas.
- Docker ejecuta `/data/bot --qr` y persiste toda la configuración bajo `/data/persistent`.

# Librerías usadas

- APIs nativas de Node/Bun para archivos, rutas, URL y JSON.
- Baileys para recibir el flujo administrativo y solicitar el borrado del mensaje sensible.
- No se agregaron dependencias.

# Archivos importantes modificados

- `src/llm-config.ts`
- `src/index.ts`
- `src/bot.ts`
- `src/context.ts`
- `README.md`
- `.gitignore`
- `.github/workflows/build-release.yml`
- `__tests__/llm-config.test.ts`
- `scripts/eliminar-configuracion-obsoleta.ps1`
- `contexto/000-contexto-maestro.md`
- `contexto/034-mascota-y-configuracion-llm.md`

# Problemas encontrados

- La entrega anterior exigía copiar y editar manualmente un archivo adicional.
- El proceso terminaba antes de vincular WhatsApp cuando faltaba la configuración.
- Docker requería montar un archivo separado fuera del volumen persistente.
- La plantilla pública era redundante una vez disponible la configuración interactiva.
- Una configuración inválida impedía usar el propio bot para repararla.

# Soluciones implementadas

- Inicio tolerante a configuración ausente o dañada; posteriormente corregido para usar OpenCode Free en vez de quedar sin LLM.
- Flujo administrativo de cuatro pasos con cancelación mediante `/cancelar`.
- Persistencia atómica dentro de `persistent/` con permisos restrictivos.
- Aplicación inmediata del proveedor y actualización asíncrona del catálogo para no bloquear el arranque.
- Fallback seguro al modelo predeterminado.
- Eliminación de la plantilla y de su inclusión en releases.
- README actualizado para instalación local y Docker sin configuración manual.

# Pendientes

- Ejecutar una prueba real con WhatsApp para confirmar si la cuenta vinculada tiene permiso de borrar el mensaje entrante que contiene la API key.
- Probar proveedores cuyo catálogo no use el formato `{ data: [{ id }] }` antes de agregar adaptadores.
- Evaluar rate limit para intentos de login y para ejecuciones repetidas de `/setup-provider`.

# Próximos pasos

- Ejecutar `bun run typecheck`, `bun test` y `bun run build`.
- Probar una instalación limpia con Docker y volumen nuevo.
- Crear el administrador con `!setup`.
- Completar `/setup-provider` y verificar la creación de `persistent/llm.config.json`.
- Recrear el contenedor y confirmar que la configuración persiste.
