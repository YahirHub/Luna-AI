# 000 — Contexto maestro del proyecto

# Fecha

2026-07-20

# Objetivo

Ser la entrada canónica para retomar Luna AI sin depender del historial del chat. Este archivo resume el estado vigente; los registros numerados conservan el detalle de cada cambio importante.

# Reglas de trabajo

- Leer primero este archivo y después los registros recientes relacionados con el área que se vaya a modificar.
- Verificar siempre el código fuente actual antes de asumir que un registro histórico sigue vigente.
- `contexto/` es la memoria persistente técnica del proyecto; evitar registros genéricos, duplicados o de tipo `actualizar nul`.
- No eliminar ni reemplazar innecesariamente `node_modules`, `assets`, `persistent` ni `dist`.
- Las eliminaciones intencionales deben quedar reproducibles mediante un script Python seguro desde la raíz del proyecto.
- Mantener aislados los datos por JID. Ninguna herramienta debe poder leer o escribir fuera del `workdir` privado del usuario.
- Mientras no exista un modelo seguro de identidad multiusuario, ignorar por completo los mensajes de grupos de WhatsApp (`@g.us`); nunca autenticar ni restaurar sesiones de grupo.
- Contraseñas, OTP y otras credenciales sensibles no deben exponerse al LLM.

# Arquitectura actual

- Runtime principal en TypeScript/Bun con WhatsApp mediante Baileys.
- OpenCode Free es el proveedor LLM integrado predeterminado; se admite proveedor OpenAI-compatible personalizado.
- La configuración de proveedores LLM personalizados solicita una sola URL base OpenAI-compatible y la API key; Luna deriva automáticamente `/models` y `/chat/completions`, consulta el catálogo y obliga a elegir por número el modelo global antes de guardar.
- El agente principal es el orquestador y delega investigación a `researcher-web` y navegación interactiva a `browser-web`.
- `spawn_agents` ejecuta subagentes aislados en paralelo y conserva resultados parciales ante fallos individuales.
- Búsqueda web multiproveedor con cola global, fallback y lectura de URLs protegida contra SSRF.
- Workdir privado por usuario con tareas, inbox, exports y registro de artefactos.
- Generación local de PDF/ZIP, envío por WhatsApp y registro de artefactos.
- Procesamiento multimedia local con FFmpeg administrado para decodificación/normalización, whisper.cpp para transcripción y OCR WASM.
- Alarmas, recordatorios, memoria y contexto persistentes por usuario.
- Credenciales web persistentes cifradas con AES-256-GCM y clave local compartida con el runtime de `agent-browser`.
- Docker multi-arquitectura basado en Debian Bookworm, Chromium del sistema y runtimes portables de FFmpeg y Whisper/libgomp.

# Estado técnico vigente

- `Dockerfile` usa `debian:bookworm-slim`; el arreglo definitivo de Whisper evita copiar una `libgomp` incompatible desde la imagen de build.
- `entrypoint.sh` mantiene `/data/bot` y `/data/runtime` fuera de escritura de `appuser`; HOME/XDG mutables viven bajo `persistent/`.
- Linux ARM64 usa Chromium del sistema porque Chrome for Testing no publica binarios para esa plataforma.
- El runtime de `agent-browser` se valida por plataforma, arquitectura y versión mediante manifest.
- El workdir valida tanto la ruta léxica como el destino real del ancestro existente más cercano, bloqueando escrituras nuevas a través de symlinks externos.
- La clave `persistent/browser/encryption.key` no se regenera si ya existe pero está corrupta, evitando invalidar silenciosamente credenciales cifradas previas.
- `credential-profiles.json` se persiste mediante reemplazo atómico.
- Los mensajes de grupos de WhatsApp se descartan antes del procesamiento y `AuthManager` rechaza/purga JIDs `@g.us`, evitando que un login grupal reemplace la sesión privada.
- Las notas OGG/Opus se decodifican con un runtime FFmpeg estático preparado por plataforma/arquitectura; se verifica su SHA-256, se empaqueta junto al binario y se compara la duración estimada del OGG con el PCM para detectar truncamientos. Whisper ya no usa `--no-timestamps` en audios largos.
- El modelo LLM es global: los campos `model` heredados de contextos por JID se ignoran y eliminan al cargarse. Cambiar de proveedor o seleccionar un modelo con `!modelos` actualiza inmediatamente todos los chats, tareas y subagentes; la selección global se persiste en `persistent/llm.model.json` ligada al catálogo del provider para impedir cruces entre proveedores.

# Archivos y módulos clave

- `src/bot.ts`: orquestación principal, mensajes, comandos y herramientas.
- `src/context.ts`: prompt de sistema, historial y compactación.
- `src/agents/`: runtime, registro y subagentes.
- `src/browser/`: navegación, sesiones y credenciales.
- `src/search/`: motores, fallback, cola y lectura segura de URLs.
- `src/workspace/`: aislamiento de archivos por usuario.
- `src/artifacts/`: PDF y ZIP.
- `src/media-processing/`: audio, Whisper y OCR.
- `scripts/`: preparación/empaquetado de runtimes y limpiezas reproducibles.

# Limpieza de contexto

- `contexto/000-contexto-maestro.md` es el maestro canónico.
- `contexto/01-contexto-maestro.md` se conserva únicamente como puntero de compatibilidad para registros históricos que todavía lo referencian.
- Se eliminaron registros exactos duplicados y registros automáticos espurios `064–069` que no representaban cambios técnicos fiables.
- Se eliminó `informe.md` porque describía soluciones ARM64 temporales que contradicen el estado final documentado en `contexto/66-runtime-multiarch-browser-whisper-docker.md`.

# Pendientes

- Ejecutar `bun run typecheck`, `bun test` y `bun run build` en un entorno con Bun 1.3.14 y dependencias instaladas.
- Mantener los registros futuros con títulos y numeración coherentes y sin duplicar documentación ya existente.

# Último registro

- `contexto/72-modelo-llm-global.md`
