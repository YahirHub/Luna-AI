# 52 — Fecha

2026-07-17

# Objetivo

Corregir la preparación de `whisper.cpp` en Debian ARM64 y otros Linux mínimos cuando `libgomp.so.1` no está instalada y APT no puede resolver el paquete desde sus índices locales.

# Antecedente

El registro `043` incorporó `libgomp.so.1` al runtime distribuible, pero la primera implementación exigía encontrar la biblioteca ya instalada en el sistema que ejecutaba `prepare:media`. En un servidor Debian ARM64 sin `libgomp1`, la preparación terminaba antes de iniciar Luna con:

```text
No se encontró libgomp.so.1 para empaquetar whisper.cpp.
```

La dependencia afecta tanto a amd64 como a ARM64 cuando se usan los binarios oficiales Ubuntu de `whisper.cpp`; no es un fallo exclusivo de ARM64.

# Decisiones tomadas

- No ejecutar `apt-get install` automáticamente.
- No ejecutar `apt-get update` ni modificar los repositorios del servidor.
- Mantener la búsqueda local mediante `LUNA_LIBGOMP_PATH`, GCC, `ldconfig` y rutas multiarch.
- Si la biblioteca no está instalada, intentar `apt-get download libgomp1`, que descarga el paquete sin instalarlo.
- Si APT no tiene índices utilizables, descargar desde `deb.debian.org` un paquete Debian Bookworm fijado por arquitectura.
- Verificar el SHA-256 del `.deb` antes de extraerlo.
- Extraer únicamente `libgomp.so.1` con `dpkg-deb` y copiarla a `runtime/whisper/system-libs`.
- Mantener el error estricto si ninguna fuente segura funciona, para no crear releases incompletos.

# Paquetes fijados

## Linux amd64

- Paquete: `libgomp1_12.2.0-14+deb12u1_amd64.deb`
- SHA-256: `48fec46bda7f5b1638b9e959889bfbc20491247d402d120bb152687eb48143d7`

## Linux ARM64

- Paquete: `libgomp1_12.2.0-14+deb12u1_arm64.deb`
- SHA-256: `a48b70dd1a95585466b40bd94564bce56ebcb2566e49ccdb6441e996aaab2098`

# Flujo actual

1. `prepare:media` busca `libgomp.so.1` instalada.
2. Si la encuentra, sigue el archivo real y lo copia al runtime.
3. Si no la encuentra, intenta descargar `libgomp1` con APT sin instalarla.
4. Si APT falla por índices ausentes o desactualizados, descarga el `.deb` fijado correspondiente a `process.arch`.
5. Verifica SHA-256.
6. Extrae `libgomp.so.1` mediante `dpkg-deb -x`.
7. Guarda la biblioteca en `assets/runtime/whisper/system-libs`.
8. El manifiesto incluye `system-libs` dentro de `libraryDirs`.
9. `whisper-cli --help` valida el runtime usando `LD_LIBRARY_PATH`.
10. `package-runtime.ts` conserva la biblioteca dentro de `dist/runtime`.

# Archivos modificados

- `scripts/whisper-linux-libs.ts`
- `scripts/prepare-media-assets.ts`
- `scripts/package-runtime.ts`
- `__tests__/whisper-linux-runtime.test.ts`
- `README.md`
- `contexto/01-contexto-maestro.md`

# Pruebas requeridas

## Debian ARM64 sin libgomp1

```bash
rm -rf assets/runtime/whisper dist
bun run prepare:media
find assets/runtime/whisper -name libgomp.so.1 -ls
bun run dev
```

El log esperado debe indicar que APT descargó el paquete o que se utilizó el paquete Debian fijado.

## Release

```bash
bun run typecheck
bun test
bun run build
find dist/runtime/whisper -name libgomp.so.1 -ls
```

# Pendientes

- Confirmar una transcripción real en Debian ARM64.
- Confirmar una transcripción real desde el release Linux amd64.
- Crear el commit únicamente después de que el usuario confirme que la transcripción funciona.
