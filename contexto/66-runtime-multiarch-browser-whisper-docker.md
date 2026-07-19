# 66 — Runtime multi-arquitectura para navegador, Whisper y Docker

# Fecha

2026-07-18

# Objetivo

Corregir de forma estructural los problemas observados en despliegues Linux ARM64 y evitar soluciones específicas de una sola arquitectura que puedan romper amd64 u otros entornos soportados.

# Problemas analizados

1. `agent-browser` sí publica binario nativo para Linux ARM64, pero Chrome for Testing no publica navegador Linux ARM64. Intentar `agent-browser install` en esa plataforma falla aunque el runtime del agente sea válido.
2. El runtime preparado de `agent-browser` se guardaba con un nombre genérico en `assets/`. Al conservar `assets/` entre builds podía reutilizarse accidentalmente un binario preparado para otra arquitectura.
3. El `postinstall` raíz podía ejecutarse durante `bun install` en Docker antes de copiar `scripts/` y `src/`.
4. El runtime Linux de Whisper podía copiar `libgomp.so.1` directamente desde la imagen de build. Si build y runtime usaban generaciones distintas de glibc, la biblioteca copiada podía exigir símbolos más nuevos que los disponibles en producción. Este problema aplica tanto a amd64 como ARM64.
5. `agent-browser` necesita un directorio escribible para su estado/IPC. Hacer `chown /data` completo funciona, pero vuelve modificables el ejecutable y los runtimes del contenedor.

# Solución implementada

## agent-browser por plataforma y arquitectura

- El nombre del binario nativo se resuelve explícitamente para Windows x64, macOS x64/ARM64 y Linux x64/ARM64, incluyendo variantes musl existentes.
- Se rechazan combinaciones para las que no existe runtime nativo conocido en vez de inventar un nombre de archivo.
- Se agregó `supportsManagedAgentBrowserChrome()`.
- Linux ARM64 nunca intenta instalar Chrome for Testing.
- En Linux ARM64 se reutiliza Chromium/Chrome del sistema.
- Si se ejecuta la preparación como root fuera del modo skip y no existe navegador, se intenta instalar Chromium mediante APT, APK o DNF.
- En Docker se desactiva deliberadamente la instalación de Chrome for Testing durante el build y se instala `chromium` con el gestor de paquetes de la imagen runtime, que entrega el paquete correcto para amd64 o ARM64.

## Manifest de agent-browser

`assets/runtime/agent-browser/manifest.json` registra:

- versión de agent-browser;
- plataforma;
- arquitectura;
- nombre nativo;
- nombre genérico.

Un binario conservado en `assets/` solo se reutiliza cuando el manifest coincide con la plataforma, arquitectura y versión actuales. Si se cambia de amd64 a ARM64 o viceversa, `prepare:browser` sustituye automáticamente el runtime obsoleto.

El manifest también se copia a `dist/runtime/agent-browser/`.

## Docker

- `bun install` se ejecuta con `--ignore-scripts` antes de copiar el código fuente.
- `bun run build` realiza después la preparación real de browser/media cuando `scripts/`, `src/` y `assets/` ya existen.
- La imagen runtime instala `chromium`, `fonts-liberation`, `xdg-utils`, `libgomp1` y `libstdc++6` mediante APT para la arquitectura real de la imagen.
- Se fija `/usr/bin/chromium` como navegador del runtime Docker.

## Whisper/libgomp global para Linux soportado

El error de glibc no se trata como un problema ARM64. La causa era copiar una `libgomp.so.1` potencialmente más nueva desde el host de build.

Ahora el camino normal de empaquetado usa una `libgomp1` Debian Bookworm fijada por arquitectura y SHA-256 para x64 y ARM64. Se genera `system-libs/portable-runtime-dependencies.json` y se reutiliza únicamente cuando coincide con la arquitectura y paquete esperado.

Esto implica que un `assets/runtime/whisper` conservado de builds anteriores que contenga una `libgomp.so.1` sin manifest portable será reparado automáticamente en el siguiente `prepare:media`/`package:runtime`.

APT queda como fallback secundario, no como primera fuente, evitando que una imagen de build Trixie vuelva a introducir una biblioteca dependiente de glibc nueva dentro de un runtime Bookworm.

## Permisos del contenedor

No se hace `chown /data` completo.

El entrypoint crea bajo `persistent/` un HOME y directorios XDG escribibles para `appuser`:

- `persistent/runtime-home`;
- `persistent/xdg-runtime`;
- caché/config/state dentro del HOME persistente.

Así `agent-browser` y Chromium pueden crear sockets, perfiles y caché sin dar permisos de escritura al usuario no root sobre `/data/bot` ni `/data/runtime`.

# Arquitecturas

- Windows x64: agent-browser nativo + Chrome for Testing administrado o navegador del sistema.
- Linux x64/amd64: agent-browser nativo + Chromium del sistema en Docker; Chrome for Testing disponible fuera de Docker.
- Linux ARM64/aarch64: agent-browser nativo + Chromium del sistema; nunca se intenta Chrome for Testing.
- macOS x64/ARM64: agent-browser nativo + Chrome for Testing administrado.
- Whisper Linux: binarios oficiales x64 y ARM64 con libgomp portable fijada para cada arquitectura soportada.

# Regla de conservación

No eliminar `node_modules`, `assets`, `persistent` ni `dist` innecesariamente. Los manifests de runtime permiten detectar y reemplazar únicamente artefactos incompatibles por arquitectura sin borrar las carpetas completas.
