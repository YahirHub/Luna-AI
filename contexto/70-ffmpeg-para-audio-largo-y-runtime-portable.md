# 70 — FFmpeg para audios largos y runtime portable

La decodificación OGG/Opus usa FFmpeg administrado por plataforma/arquitectura, normaliza a PCM mono 16 kHz y valida la duración para detectar truncamientos. El runtime se prepara en dev/start/build y se empaqueta junto al binario. Whisper conserva timestamps internos para audios largos.
