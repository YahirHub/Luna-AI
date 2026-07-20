# 51 — Incluir libgomp en el runtime Linux

2026-07-17

# Objetivo

Corregir la ejecución de `whisper-cli` en distribuciones Linux mínimas que no incluyen `libgomp.so.1`.

# Decisiones tomadas

- Mantener los binarios oficiales de `whisper.cpp`.
- Incluir `libgomp.so.1` dentro del runtime distribuible de Luna.
- No exigir que el usuario instale manualmente `libgomp1`.
- Buscar la biblioteca mediante `LUNA_LIBGOMP_PATH`, GCC, `ldconfig` y rutas multiarch conocidas.
- Mantener `LD_LIBRARY_PATH` limitado al subproceso de Whisper.

# Arquitectura actual

- `scripts/prepare-media-assets.ts` prepara `whisper.cpp`, repara SONAME e incorpora las dependencias Linux externas.
- `scripts/whisper-linux-libs.ts` localiza y copia `libgomp.so.1` a `runtime/whisper/system-libs`.
- `scripts/package-runtime.ts` repite la validación después de copiar el runtime a `dist/`.
- `src/media-processing/whisper-native.ts` descubre todas las carpetas con bibliotecas y las agrega a `LD_LIBRARY_PATH`.
- GitHub Actions verifica que cada paquete Linux contenga `runtime/whisper/system-libs/libgomp.so.1`.

# Librerías usadas

- `libgomp.so.1`, runtime de GNU OpenMP requerido por los binarios oficiales Ubuntu de `whisper.cpp`.

# Archivos importantes modificados

- `scripts/whisper-linux-libs.ts`
- `scripts/prepare-media-assets.ts`
- `scripts/package-runtime.ts`
- `Dockerfile`
- `.github/workflows/build-release.yml`
- `__tests__/whisper-linux-runtime.test.ts`
- `__tests__/runtime-packaging.test.ts`
- `README.md`

# Problemas encontrados

El paquete Linux incluía las bibliotecas propias de Whisper y GGML, pero `whisper-cli` también enlaza dinámicamente con OpenMP. En servidores mínimos el cargador fallaba con:

```text
libgomp.so.1: cannot open shared object file: No such file or directory
```

Instalar `libgomp1` en Docker no corregía los paquetes `.tar.gz` ejecutados directamente fuera del contenedor.

# Soluciones implementadas

- Copia de la biblioteca real, siguiendo enlaces simbólicos, dentro de `runtime/whisper/system-libs/libgomp.so.1`.
- Inclusión automática tanto en runtimes nuevos como cacheados.
- Repetición de la inclusión después del empaquetado a `dist/`.
- Instalación de `libgomp1` también en la etapa de compilación Docker para validar `whisper-cli`.
- Comprobación explícita de `libgomp.so.1` en los jobs Linux amd64 y arm64.
- Pruebas para verificar la copia y evitar duplicados.

# Pendientes

- Ejecutar una transcripción real desde los paquetes Linux amd64 y arm64 generados por GitHub Actions.
- Vigilar si releases futuros de `whisper.cpp` incorporan nuevas dependencias externas.

# Próximos pasos

1. Ejecutar el workflow completo.
2. Extraer el paquete Linux en un sistema sin `libgomp1`.
3. Confirmar con `ldd` que `libgomp.so.1` se resuelve desde `runtime/whisper/system-libs`.
4. Enviar una nota de voz y confirmar la transcripción.
