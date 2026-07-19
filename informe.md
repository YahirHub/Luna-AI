# Informe de errores y soluciones — luna-ai en ARM64

> **Fecha:** 18 de julio de 2026
> **Servidor:** Oracle Cloud ARM64 (aarch64) — Ubuntu host, contenedores Docker
> **Proyecto:** luna-ai (whatsapp-bot con whisper.cpp, agent-browser, OpenCode Free)
> **Archivos modificados:** `Dockerfile`, `entrypoint.sh`

---

## Índice

1. [Error 1 — GLIBC_2.38 no encontrado por whisper.cpp](#error-1--glibc_238-no-encontrado-por-whispercpp)
2. [Error 2 — Module not found: scripts/prepare-agent-browser.ts (postinstall)](#error-2--module-not-found-scriptsprepare-agent-browserts-postinstall)
3. [Error 3 — Chrome for Testing no disponible para ARM64 Linux](#error-3--chrome-for-testing-no-disponible-para-arm64-linux)
4. [Error 4 — failed to create socket: Permission denied (agent-browser)](#error-4--failed-to-create-socket-permission-denied-agent-browser)
5. [Resumen de cambios](#resumen-de-cambios)
6. [Estado actual del despliegue](#estado-actual-del-despliegue)

---

## Error 1 — GLIBC_2.38 no encontrado por whisper.cpp

### Síntoma

```
❌ whisper.cpp no pudo transcribir el audio:
/data/runtime/whisper/bin/whisper-bin-ubuntu-arm64/whisper-cli:
/lib/aarch64-linux-gnu/libc.so.6: version `GLIBC_2.38' not found
(required by /data/runtime/whisper/system-libs/libgomp.so.1)
```

### Causa raíz

El `libgomp.so.1` que se empaquetaba en `system-libs/` se extraía del **build stage** (`oven/bun:1.3.14`). Dicha imagen oficial de Bun está basada en **Debian Trixie** (antes conocido como Testing), que incluye **glibc 2.41**.

Sin embargo, la imagen **runtime** era `debian:bookworm-slim`, que solo tiene **glibc 2.36**.

El binario `libgomp.so.1` empaquetado requería símbolos de glibc ≥ 2.38, que no existen en Bookworm. En consecuencia, `whisper-cli` no podía cargar OpenMP y fallaba en tiempo de ejecución.

> **Nota:** En el host no ocurría porque el sistema tenía glibc 2.41 o superior.

### Solución aplicada

**Cambiar la imagen runtime de `debian:bookworm-slim` a `debian:trixie-slim`.**

```diff
-FROM debian:bookworm-slim
+FROM debian:trixie-slim
```

**Razonamiento:** Debian Trixie es stable desde agosto de 2025, incluye glibc 2.41 (compatible con el `libgomp.so.1` empaquetado), y es la misma base que usa `oven/bun:1.3.14` en el build stage.

### Archivos afectados

- `Dockerfile` (local y remoto)

### Verificación

```bash
# Dentro del contenedor:
$ /data/runtime/whisper/bin/whisper-bin-ubuntu-arm64/whisper-cli --help
# → load_backend: loaded CPU backend  (sin errores GLIBC)
```

---

## Error 2 — Module not found: scripts/prepare-agent-browser.ts (postinstall)

### Síntoma

```
$ bun run prepare:browser
$ bun run scripts/prepare-agent-browser.ts
error: Module not found "scripts/prepare-agent-browser.ts"
error: script "prepare:browser" exited with code 1
error: postinstall script from "whatsapp-bot" exited with 1
```

### Causa raíz

El `package.json` define:

```json
"postinstall": "bun run prepare:browser",
"prepare:browser": "bun run scripts/prepare-agent-browser.ts"
```

En el Dockerfile original, el orden era:

```dockerfile
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --production --frozen-lockfile   # ← postinstall se ejecuta AQUÍ
COPY scripts ./scripts                           # ← scripts se copia DESPUÉS
COPY assets ./assets
COPY src ./src
RUN bun run build
```

Cuando `bun install` ejecutaba el postinstall, `scripts/` todavía no existía en la imagen (se copiaba después), por lo que `prepare-agent-browser.ts` no se encontraba.

Además, incluso si `scripts/` hubiera estado disponible, el script `prepare-agent-browser.ts` importa `../src/browser/browser-discovery.ts`, y `src/` tampoco se había copiado aún.

### Solución aplicada

```diff
-COPY package.json bun.lock ./
-COPY patches ./patches
-RUN bun install --production --frozen-lockfile

-COPY scripts ./scripts
-COPY assets ./assets
-COPY src ./src
-RUN bun run build
+COPY package.json bun.lock ./
+COPY patches ./patches
+RUN bun install --production --frozen-lockfile --ignore-scripts
+
+COPY scripts ./scripts
+COPY assets ./assets
+COPY src ./src
+RUN bun run build
```

**Cambios:**
1. Se agregó la flag `--ignore-scripts` a `bun install` para evitar que el postinstall se ejecute antes de tener los archivos necesarios.
2. El script `prepare:browser` ahora se ejecuta dentro de `RUN bun run build` (que corre `prepare:browser && prepare:media && bun build...`), momento en el que `scripts/`, `assets/` y `src/` ya están copiados.

**Beneficio adicional:** La capa de instalación de dependencias ahora solo se invalida cuando cambian `package.json`, `bun.lock` o `patches/`, no cuando cambia el código fuente.

### Archivos afectados

- `Dockerfile` (local y remoto)

---

## Error 3 — Chrome for Testing no disponible para ARM64 Linux

### Síntoma

```
✗ Chrome for Testing does not provide Linux ARM64 builds.
  Install Chromium from your system package manager instead:
    sudo apt install chromium-browser   # Debian/Ubuntu
    sudo dnf install chromium            # Fedora
  Then use: agent-browser --executable-path /usr/bin/chromium

error: agent-browser install terminó con código 1.
```

### Causa raíz

El script `prepare-agent-browser.ts` ejecuta `agent-browser install` para descargar **Chrome for Testing**, que es el binario de Chrome que Google publica específicamente para pruebas automatizadas.

**Google Chrome for Testing NO proporciona binarios para Linux ARM64** (solo para `linux/amd64`, `mac/arm64`, `mac/amd64`, `win32`, `win64`). En un servidor ARM64 (aarch64), el comando falla inmediatamente.

### Solución aplicada

**En el build stage (Dockerfile):**

```dockerfile
ENV LUNA_AGENT_BROWSER_SKIP_INSTALL=1
```

Esta variable de entorno hace que `prepare-agent-browser.ts` omita la instalación de Chrome for Testing y continúe sin navegador administrado.

El script ya tiene lógica para manejar este caso:
```typescript
if (process.env.LUNA_AGENT_BROWSER_SKIP_INSTALL === "1") {
    console.warn("[agent-browser] Se omite Chrome for Testing por LUNA_AGENT_BROWSER_SKIP_INSTALL=1. Se omite la instalación automática.");
    return;
}
```

**En el runtime stage (Dockerfile):**

Se agregó el paquete `chromium` de Debian al `apt-get install`:

```diff
 RUN apt-get update \
     && apt-get install -y --no-install-recommends \
         bash \
         ca-certificates \
+        chromium \
+        fonts-liberation \
         gosu \
         libgomp1 \
         libstdc++6 \
+        xdg-utils \
     && rm -rf /var/lib/apt/lists/* \
```

**Detalles de la instalación:**
- **Paquete:** `chromium` (versión 150.0.7871.124 para ARM64)
- **Repositorio:** `trixie-security` (Debian 13)
- **Tamaño:** ~753 MB adicionales (171 paquetes nuevos)
- **Ruta:** `/usr/bin/chromium`

**Resolución del navegador en runtime:**

El método `env()` en `browser-runtime.ts` tiene esta prioridad para localizar el navegador:

```typescript
const explicitBrowser = process.env.AGENT_BROWSER_EXECUTABLE_PATH?.trim();
const browserExecutable = explicitBrowser && existsSync(explicitBrowser)
  ? explicitBrowser
  : resolveManagedAgentBrowserChrome() ?? resolveSystemBrowserExecutable();
```

1. `AGENT_BROWSER_EXECUTABLE_PATH` (variable de entorno explícita)
2. Chrome for Testing administrado (no disponible en ARM64 → se salta)
3. Navegador del sistema → `resolveSystemBrowserExecutable()` busca en PATH: `chromium`, `google-chrome`, etc.

Con Chromium instalado desde apt, `resolveSystemBrowserExecutable()` encuentra `/usr/bin/chromium` automáticamente.

### Archivos afectados

- `Dockerfile` (remoto únicamente; el local aún no incluye chromium)

---

## Error 4 — failed to create socket: Permission denied (agent-browser)

### Síntoma

```
failed to create socket, directorio: permiso denegado error 13
```

### Causa raíz

El bot se ejecuta como `appuser` (usuario no root) mediante `gosu` en el `entrypoint.sh`:

```bash
exec gosu appuser "$@"
```

El usuario `appuser` fue creado con `--home-dir /data`, por lo que `HOME=/data`.

Sin embargo, `/data/` es propiedad de `root:root` con permisos `drwxr-xr-x` (755), lo que significa que `appuser` **no puede escribir en su propio home directory**.

El binario `agent-browser` (escrito en Go) intenta crear **Unix domain sockets** para su IPC (comunicación entre procesos) en el home directory o en el directorio de trabajo (`PWD=/data`), y falla con `EACCES` (errno 13 → "Permission denied").

```
appuser HOME=/data
appuser PWD=/data
/data/ owner: root:root (755)
→ appuser NO puede escribir en /data/
→ agent-browser no puede crear sockets → error 13
```

**Diagnóstico:**

```bash
$ su -s /bin/sh appuser -c 'touch /data/test'
touch: cannot touch '/data/test': Permission denied

$ su -s /bin/sh appuser -c 'touch /data/persistent/test'
# OK (persistent/ está chowned a appuser)
```

### Solución aplicada (remoto)

Se agregó `chown appuser:appgroup /data` al `entrypoint.sh` remoto:

```diff
 chown -R appuser:appgroup "$PERSISTENT_DIR"
+chown appuser:appgroup /data
```

Esto hace que `/data/` sea propiedad de `appuser:appgroup`, permitiendo que cualquier proceso que se ejecute como `appuser` pueda escribir en el directorio.

### Consideraciones de seguridad

- `chown appuser:appgroup /data` hace que `appuser` pueda modificar cualquier archivo dentro de `/data/`, incluyendo el binario `bot` y los binarios en `runtime/`. En un contenedor Docker, esto es aceptable porque la barrera de seguridad es el contenedor mismo.
- Una alternativa más quirúrgica sería establecer `export HOME=/data/persistent` antes del `gosu`, limitando los directorios escribibles a solo `persistent/`.

### Archivos afectados

- `entrypoint.sh` (remoto únicamente; el local no incluye el chown)

### Verificación

```bash
$ docker exec luna-ai su -s /bin/sh appuser -c \
    '/data/runtime/agent-browser/agent-browser --help'
# → agent-browser - fast browser automation CLI for AI agents

$ docker exec luna-ai su -s /bin/sh appuser -c 'touch /data/test && rm /data/test'
# → OK
```

**Logs de producción (bot funcionando):**

```json
{
  "scope": "browser.runtime",
  "event": "command_started",
  "data": {
    "command": "open https://www.google.com",
    "executablePath": "/usr/bin/chromium",
    "timeoutMs": 45000
  }
}
{
  "scope": "browser.runtime",
  "event": "command_completed",
  "data": {
    "command": "open https://www.google.com",
    "durationMs": 1561,
    "outputChars": 164
  }
}
```

---

## Resumen de cambios

| # | Error | Archivo(s) | Cambio | Local | Remoto |
|---|-------|-----------|--------|-------|--------|
| 1 | GLIBC_2.38 not found | `Dockerfile` | `bookworm-slim` → `trixie-slim` | ✅ | ✅ |
| 2 | Module not found en postinstall | `Dockerfile` | `--ignore-scripts`; mover scripts antes del build | ✅ | ✅ |
| 3 | Chrome for Testing no disponible en ARM64 | `Dockerfile` | `LUNA_AGENT_BROWSER_SKIP_INSTALL=1` + instalar `chromium` desde apt | ⚠️ Solo la env var | ✅ Completo |
| 4 | Permission denied al crear socket | `entrypoint.sh` | `chown appuser:appgroup /data` | ❌ | ✅ |

**Leyenda:**
- ✅ = Cambio aplicado permanentemente
- ⚠️ = Cambio aplicado parcialmente (solo la parte del build stage)
- ❌ = Cambio NO aplicado (solo existe en remoto)

---

## Estado actual del despliegue

### Contenedor

```bash
$ docker ps
NAMES      STATUS         IMAGE
luna-ai    Up 2 hours     luna-ai:latest
```

### Funcionalidades verificadas

| Funcionalidad | Estado | Detalle |
|--------------|--------|---------|
| WhatsApp (Baileys) | ✅ | Conectado, sesión reutilizada |
| whisper.cpp (transcripción) | ✅ | CPU backend cargado, sin errores GLIBC |
| agent-browser (navegación web) | ✅ | Chromium 150.0.7871.124 ARM64, comandos open/snapshot OK |
| Recordatorios y alarmas | ✅ | Verificadores cada 30s |
| OpenCode Free (LLM) | ✅ | Proveedor activo |

### Imagen Docker

- **Versión Bun:** 1.3.14
- **Base:** `debian:trixie-slim` (glibc 2.41)
- **Chromium:** 150.0.7871.124 ARM64 (desde repos Debian)
- **Tamaño estimado:** ~1.5 GB (incluyendo chromium + whisper + runtime)

### Puertos

- Ninguno expuesto externamente (solo WebSocket saliente para WhatsApp)
