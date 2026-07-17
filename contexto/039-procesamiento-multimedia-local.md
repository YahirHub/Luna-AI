# Fecha

2026-07-17

# Objetivo

Permitir que Luna transcriba notas de voz y extraiga texto de imágenes localmente, sin API keys ni instalaciones manuales de FFmpeg, Python o Tesseract, manteniendo un build reproducible con Bun.

# Decisiones tomadas

- Admitir notas OGG/Opus de hasta 12 MB y 120 segundos.
- Decodificar OGG/Opus con `ogg-opus-decoder`, mezclar a mono y reducir a 16 kHz.
- Generar WAV PCM de 16 bits mediante TypeScript, sin FFmpeg.
- Sustituir `@timur00kh/whisper.wasm` porque su ejecución quedaba esperando eventos de finalización incompatibles con Bun.
- Usar el `whisper-cli` oficial publicado en la release `latest` de whisper.cpp.
- Seleccionar automáticamente `whisper-bin-x64.zip`, `whisper-bin-Win32.zip`, `whisper-bin-ubuntu-x64.tar.gz` o `whisper-bin-ubuntu-arm64.tar.gz` según plataforma y arquitectura.
- Verificar el digest SHA-256 publicado por la API de GitHub antes de extraer el runtime.
- Mantener el modelo multilingüe cuantizado `ggml-base-q5_1.bin`, verificado mediante SHA-256.
- Distribuir `runtime/whisper/` junto al ejecutable de Luna, incluyendo bibliotecas compartidas y modelo.
- Mantener Tesseract WASM embebido para OCR JPEG/PNG en español.
- Ejecutar multimedia en un subproceso persistente del mismo binario para no bloquear WhatsApp.
- Mantener una cola serial con máximo tres trabajos pendientes.
- Procesar archivos temporales fuera de `persistent/` y eliminarlos al terminar.
- Cambiar Docker de Alpine a Debian glibc para ejecutar los binarios oficiales Ubuntu de whisper.cpp.

# Arquitectura actual

```text
WhatsApp OGG/Opus
        │
        ▼
ogg-opus-decoder WASM
        │
        ▼
PCM mono 16 kHz → WAV temporal
        │
        ▼
runtime/whisper/whisper-cli
        │
        ▼
texto de salida → contexto del usuario → LLM

WhatsApp JPEG/PNG
        │
        ▼
Tesseract WASM en subproceso
        │
        ▼
texto OCR → contexto del usuario → LLM
```

# Librerías usadas

- `ogg-opus-decoder` 1.7.3.
- `tesseract-wasm` 0.11.0.
- `@tesseract.js-data/spa` 1.0.0.
- `jpeg-js` 0.4.4.
- `pngjs` 7.0.0.
- Runtime oficial de whisper.cpp obtenido desde `releases/latest`.
- Modelo `ggml-base-q5_1.bin` verificado por SHA-256.

# Archivos importantes modificados

- `package.json`
- `bun.lock`
- `Dockerfile`
- `entrypoint.sh`
- `.github/workflows/build-release.yml`
- `README.md`
- `scripts/prepare-media-assets.ts`
- `scripts/package-runtime.ts`
- `scripts/eliminar-whisper-wasm-obsoleto.ps1`
- `src/media-processing/worker.ts`
- `src/media-processing/whisper-native.ts`
- `__tests__/whisper-native.test.ts`
- `__tests__/runtime-packaging.test.ts`

# Problemas encontrados

- Whisper WASM quedaba indefinidamente en `Transcribe timeout` porque el wrapper esperaba una señal de finalización que Bun no recibía de forma fiable.
- Los Workers embebidos de Bun resolvían rutas hacia `src/` en el ejecutable Windows.
- El binario oficial Linux de whisper.cpp usa glibc y no es compatible de forma fiable con Alpine/musl.
- Copiar solo `luna-ai.exe` no basta para el runtime nativo: deben conservarse las DLL/so y el modelo.
- Consultar siempre la release más reciente requiere verificar el digest dinámico y guardar la versión exacta usada en un manifiesto.

# Soluciones implementadas

- Eliminada la dependencia y el parche de `@timur00kh/whisper.wasm`.
- Implementado `whisper-native.ts` para generar WAV, localizar el runtime y ejecutar `whisper-cli` con timeout y limpieza de temporales.
- Implementado un preparador que consulta `releases/latest`, selecciona el asset de la plataforma, verifica el SHA-256 y conserva un runtime cacheado como fallback si GitHub no está disponible.
- Implementado `manifest.json` con versión, asset, digest, arquitectura, ejecutable, modelo y directorios de bibliotecas.
- `bun run build` copia el runtime a `dist/runtime/whisper/`.
- GitHub Actions crea archivos `.zip` o `.tar.gz` completos para Windows amd64, Linux amd64 y Linux arm64.
- Docker usa Debian slim y copia el runtime preparado junto al bot.
- WhatsApp muestra únicamente `Transcribiendo audio...` o `Extrayendo texto de la imagen...`; si falla multimedia, no se llama al LLM.

# Pendientes

- Ejecutar una prueba real de las tres plataformas desde GitHub Actions.
- Medir rendimiento del modelo Base cuantizado en hardware x64 y ARM64.
- Evaluar un modelo mayor solo si la precisión real lo requiere.
- Confirmar periódicamente que los nombres de assets oficiales se mantengan; el preparador fallará de forma explícita si cambian.

# Próximos pasos

- Ejecutar `bun install --frozen-lockfile`, `bun run typecheck`, `bun test` y `bun run build`.
- Probar una nota de voz usando `dist/luna-ai.exe` con `dist/runtime/` presente.
- Ejecutar el workflow manual y probar cada paquete descargado en una máquina limpia.
