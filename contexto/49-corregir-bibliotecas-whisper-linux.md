# 49 — Fecha

2026-07-17

# Objetivo

Corregir los paquetes Linux de Luna que incluían `whisper-cli`, pero fallaban al iniciar porque el cargador dinámico no encontraba `libwhisper.so.1`.

# Decisiones tomadas

- Mantener los binarios oficiales de `whisper.cpp`; no compilar una variante estática propia.
- Mantener el runtime junto al ejecutable de Luna.
- Configurar `PATH` y `LD_LIBRARY_PATH` únicamente para el subproceso `whisper-cli`, sin modificar globalmente el servidor.
- Convertir los enlaces SONAME de las bibliotecas Linux en copias regulares durante la preparación y el empaquetado.
- Validar `whisper-cli --help` durante el build Linux para impedir que se publique un runtime que no pueda cargar sus bibliotecas.

# Arquitectura actual

1. `scripts/prepare-media-assets.ts` descarga y extrae el paquete oficial correspondiente a Linux.
2. `scripts/whisper-linux-libs.ts` detecta bibliotecas versionadas como `libwhisper.so.1.9.1`.
3. Se crean copias portables con los nombres requeridos por el cargador, como `libwhisper.so.1` y `libwhisper.so`.
4. El manifiesto vuelve a calcular todas las carpetas que contienen bibliotecas.
5. En Linux se ejecuta `whisper-cli --help` con `LD_LIBRARY_PATH` antes de aceptar el runtime.
6. `scripts/package-runtime.ts` repite la reparación después de copiar el runtime a `dist/`.
7. `src/media-processing/whisper-native.ts` descubre carpetas de bibliotecas aunque el manifiesto sea antiguo y las agrega al entorno de `Bun.spawn`.

# Librerías usadas

- APIs nativas de Bun para procesos y preparación del runtime.
- `node:fs` y `node:path` para inspección, copia y resolución segura de archivos.
- Binarios oficiales de `whisper.cpp` sin dependencias nuevas de npm.

# Archivos importantes modificados

- `src/media-processing/whisper-native.ts`
- `scripts/prepare-media-assets.ts`
- `scripts/package-runtime.ts`
- `scripts/whisper-linux-libs.ts`
- `__tests__/whisper-native.test.ts`
- `__tests__/whisper-linux-runtime.test.ts`
- `__tests__/runtime-packaging.test.ts`
- `README.md`
- `contexto/01-contexto-maestro.md`

# Problemas encontrados

El paquete oficial usa enlaces simbólicos para nombres ABI como:

```text
libwhisper.so.1 -> libwhisper.so.1.9.1
```

Algunos extractores o pasos de empaquetado no conservaban esos enlaces. Aunque la biblioteca versionada existía y Luna configuraba `LD_LIBRARY_PATH`, Linux solicitaba exactamente `libwhisper.so.1` y no encontraba ese nombre.

# Soluciones implementadas

- Se restauran los aliases `.so` y `.so.<major>` como archivos regulares.
- La reparación se aplica tanto a runtimes recién descargados como a runtimes cacheados.
- La reparación se repite después de copiar a `dist/runtime/whisper`.
- `loadWhisperRuntime()` descubre dinámicamente carpetas con `.so`, `.dylib` o `.dll`.
- `buildWhisperEnvironment()` agrega la carpeta del ejecutable y todas las carpetas de bibliotecas a `PATH` y `LD_LIBRARY_PATH`.
- El build Linux valida que `whisper-cli` pueda iniciar antes de continuar.
- Se añadieron pruebas para aliases SONAME, entorno Linux y empaquetado.

# Pendientes

- Ejecutar el workflow real de Linux amd64 y Linux arm64.
- Probar una nota de voz en ambos paquetes generados.
- Verificar con `ldd runtime/whisper/**/whisper-cli` que no aparezcan bibliotecas `not found`.

# Próximos pasos

1. Ejecutar `bun run build` en Linux o el workflow de release.
2. Confirmar que la preparación muestre los aliases restaurados cuando sean necesarios.
3. Ejecutar el paquete desde una carpeta limpia.
4. Enviar una nota de voz y confirmar la transcripción.
