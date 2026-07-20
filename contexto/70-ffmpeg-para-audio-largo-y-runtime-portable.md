# 70 — FFmpeg para audio largo y runtime portable

# Fecha

2026-07-20

# Problema

Las notas de voz OGG/Opus se decodificaban mediante `ogg-opus-decoder` antes de enviarse a whisper.cpp. En audios largos, una decodificación parcial podía terminar siendo aceptada como válida porque el pipeline no verificaba de forma fiable que el PCM generado cubriera toda la duración del contenedor OGG.

# Solución vigente

- Se eliminó `ogg-opus-decoder` y su parche de Bun.
- FFmpeg decodifica OGG/Opus y normaliza directamente a PCM Float32 mono de 16 kHz.
- `estimateOggDurationSeconds()` se conserva para estimar la duración del contenedor antes de decodificar y aplicar el límite configurado.
- Después de FFmpeg se compara la duración PCM con la duración OGG estimada usando una tolerancia pequeña. Si el PCM queda claramente corto, la transcripción falla explícitamente en vez de devolver texto parcial como si fuera completo.
- `whisper-cli` ya no recibe `--no-timestamps`, permitiendo que Whisper conserve su segmentación temporal interna para audios largos; el resultado para Luna sigue siendo el archivo TXT final.

# Runtime FFmpeg

`bun run dev`, `bun run start` y `bun run build` ejecutan `prepare:media`.

`prepare-media-assets.ts`:

1. Detecta `process.platform` y `process.arch`.
2. Selecciona `ffmpeg-<platform>-<arch>.gz` de la release fijada `b6.1.1` de `eugeneware/ffmpeg-static`.
3. Consulta la release mediante GitHub API y exige un digest `sha256:` válido.
4. Descarga con reintentos y reanudación usando la infraestructura existente de assets multimedia.
5. Verifica SHA-256 antes de descomprimir.
6. Guarda `assets/runtime/ffmpeg/ffmpeg` o `ffmpeg.exe` junto a `manifest.json`.
7. Ejecuta `ffmpeg -version` para validar el runtime.
8. Reutiliza el runtime local si coincide o si GitHub no está disponible pero el runtime existente sigue siendo válido.

Puede usarse `FFMPEG_STATIC_ARCHIVE_PATH` para preparar el runtime desde un `.gz` local que coincida con el digest publicado, y `FFMPEG_STATIC_RELEASE_TAG` para cambiar explícitamente la release.

# Empaquetado

`package-runtime.ts` copia `assets/runtime/ffmpeg/` a `dist/runtime/ffmpeg/` excluyendo `.downloads`. El binario standalone resuelve el runtime junto al ejecutable, igual que Whisper.

Docker copia `dist/runtime` completo y garantiza permiso de ejecución para `/data/runtime/ffmpeg/ffmpeg` en Linux.

# Compatibilidad

La configuración explícita actual admite:

- Linux x64, arm64, arm e ia32 para FFmpeg.
- Windows x64 para FFmpeg.

La compatibilidad final de Luna continúa limitada también por las plataformas para las que exista runtime de `whisper-cli`; actualmente el flujo principal del proyecto empaqueta Linux x64, Linux arm64 y Windows x64.

# Seguridad y robustez

- No se usa un FFmpeg instalado globalmente.
- El binario descargado se valida con SHA-256 publicado por GitHub.
- La ruta del runtime se valida contra el manifest y no puede escapar de su directorio.
- La conversión se ejecuta con `-nostdin`, timeout y directorio temporal eliminado al finalizar.
- Se usan `+discardcorrupt` e `ignore_err` para intentar continuar ante paquetes dañados recuperables, sin aceptar silenciosamente un PCM claramente truncado.

# Archivos principales

- `src/media-processing/ffmpeg-native.ts`
- `src/media-processing/worker.ts`
- `src/media-processing/whisper-native.ts`
- `src/media-processing/audio-utils.ts`
- `scripts/prepare-media-assets.ts`
- `scripts/package-runtime.ts`
- `scripts/remove-obsolete-ogg-opus.py`
- `Dockerfile`
- `package.json`
- `bun.lock`

# Pruebas requeridas

1. `bun install --frozen-lockfile`
2. `bun run typecheck`
3. `bun test`
4. `bun run dev` y confirmar que prepara/reutiliza `assets/runtime/ffmpeg`.
5. Enviar una nota OGG/Opus corta y verificar transcripción normal.
6. Enviar una nota de voz de más de 30 segundos y comprobar que se transcribe hasta el final.
7. Probar un audio cercano a `maxAudioSeconds`.
8. Ejecutar `bun run build` y comprobar `dist/runtime/ffmpeg/manifest.json` y el ejecutable FFmpeg.
9. Probar el paquete standalone en Windows x64 y Linux x64/arm64 según corresponda.
