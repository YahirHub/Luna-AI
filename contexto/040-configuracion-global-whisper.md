# Fecha

2026-07-17

# Objetivo

Permitir que una cuenta administradora configure globalmente Whisper desde WhatsApp, seleccione modelos oficiales, descargue modelos adicionales de forma segura y ajuste los parámetros de transcripción sin editar archivos, recompilar ni reiniciar Luna.

# Decisiones tomadas

- Agregar el comando administrativo `!setup-whisper`.
- Mantener `ggml-base-q5_1.bin` (`base-q5_1`) como modelo incluido y predeterminado.
- Mostrar el catálogo oficial de modelos compatibles con whisper.cpp, su tamaño aproximado, idioma y estado local.
- Descargar modelos adicionales únicamente después de confirmación explícita del administrador.
- Guardar la configuración global en `persistent/whisper.json`.
- Guardar modelos adicionales en `persistent/whisper/models/` para que persistan en Docker.
- Aplicar los cambios al siguiente audio sin reiniciar el bot.
- Validar y normalizar todos los parámetros antes de persistirlos.
- Verificar espacio libre, tamaño y SHA-256 antes de activar un modelo descargado.
- Conservar descargas parciales para poder reanudarlas.
- Permitir eliminar modelos descargados que no estén activos.
- Mantener los modelos `.en` restringidos al idioma inglés.
- Ordenar al asistente que confirme una transcripción automática ambigua antes de ejecutar herramientas o acciones persistentes.

# Arquitectura actual

```text
Administrador de WhatsApp
        │
        ▼
!setup-whisper
        │
        ├── seleccionar modelo disponible
        ├── confirmar y descargar modelo ausente
        ├── configurar idioma y traducción
        ├── configurar CPU y decodificación
        ├── configurar límites y timeout
        └── limpiar modelos inactivos
        │
        ▼
persistent/whisper.json
persistent/whisper/models/*.bin
        │
        ▼
Siguiente nota de voz
        │
        ▼
whisper-cli con configuración global activa
```

El modelo incluido continúa dentro de `runtime/whisper/models/`. Un modelo descargado se resuelve primero desde el almacenamiento persistente y no modifica el runtime distribuido.

# Librerías usadas

- Bun y APIs nativas de filesystem, streams, hashing SHA-256 y `fetch`.
- Runtime oficial de whisper.cpp ya integrado en el proyecto.
- Repositorio oficial de modelos `ggerganov/whisper.cpp` en Hugging Face.
- No se agregaron dependencias npm.

# Archivos importantes modificados

- `src/whisper-config.ts`
- `src/whisper-setup.ts`
- `src/media-processing/whisper-native.ts`
- `src/media-processing/worker.ts`
- `src/media-processing/client.ts`
- `src/media.ts`
- `src/bot.ts`
- `src/context.ts`
- `README.md`
- `__tests__/whisper-config.test.ts`
- `__tests__/whisper-native.test.ts`
- `__tests__/commands.test.ts`
- `__tests__/media-flow.test.ts`
- `contexto/000-contexto-maestro.md`

# Problemas encontrados

- El modelo incluido estaba fijado en el build y no podía cambiarse globalmente sin modificar código y recompilar.
- Los modelos grandes requieren control de espacio disponible, integridad y progreso para evitar archivos corruptos o descargas invisibles.
- En Windows no se puede reemplazar de forma fiable un archivo descargado mientras su descriptor permanece abierto.
- Un error al enviar un mensaje de progreso por WhatsApp no debe cancelar una descarga ya avanzada.
- Una transcripción incorrecta podría interpretarse como una orden para crear o modificar datos persistentes.

# Soluciones implementadas

- Implementado un catálogo tipado de 34 modelos y variantes oficiales con tamaños aproximados.
- Implementada persistencia atómica y normalización de la configuración global.
- Implementada descarga incremental con reanudación, timeout de conexión, timeout por inactividad y límite total.
- Implementada obtención de tamaño y SHA-256 desde metadatos LFS oficiales, con fallback mediante `HEAD`.
- Implementada verificación de espacio libre y SHA-256 antes de renombrar el archivo definitivo.
- El descriptor del archivo parcial se cierra antes de calcular el hash y reemplazar el destino, para mantener compatibilidad con Windows.
- Los errores de notificación de progreso se registran, pero no interrumpen la descarga.
- `whisper-cli` recibe modelo, idioma, traducción, hilos, `best-of`, `beam-size`, temperatura, umbral sin voz y timeout desde la configuración activa.
- El límite de duración del audio se aplica antes de descargar y procesar la nota.
- El prompt del sistema exige confirmar transcripciones ambiguas antes de crear, editar o eliminar recordatorios, alarmas, memoria u otras acciones.

# Pendientes

- Ejecutar una descarga real de un modelo alternativo desde WhatsApp en Windows y Docker.
- Medir rendimiento y precisión de Small, Medium y Turbo en el hardware objetivo.
- Considerar paginación del catálogo en varios mensajes si WhatsApp cambia sus límites de texto.
- Evaluar límites de almacenamiento por administrador si se habilitan modelos de varios GiB en instalaciones compartidas.

# Próximos pasos

- Ejecutar `bun run typecheck`, `bun test` y `bun run build` con Bun y dependencias reales.
- Probar `!setup-whisper` con una cuenta normal y una administradora.
- Descargar `tiny-q5_1`, activarlo, reiniciar y confirmar persistencia.
- Restaurar `base-q5_1` y limpiar el modelo descargado.
- Enviar una transcripción deliberadamente ambigua y comprobar que Luna solicite confirmación antes de ejecutar acciones.
