# 01 — Contexto maestro del proyecto

# Fecha

2026-07-16

# Objetivo

Conservar el estado técnico, las reglas y los pendientes necesarios para retomar el proyecto.

# Decisiones tomadas

- La carpeta contexto/ es la memoria persistente del proyecto.

# Arquitectura actual

- Consultar los registros numerados y verificar el código fuente antes de cambiar la arquitectura.

# Librerías usadas

- Consultar los manifiestos del proyecto y los registros numerados.

# Archivos importantes modificados

- Consultar el registro más reciente.

# Problemas encontrados

- Consultar el registro más reciente.

# Soluciones implementadas

- Consultar el registro más reciente.

# Pendientes

- Mantener este archivo actualizado después de cambios importantes.

# Próximos pasos

- Leer este documento y luego los archivos numerados en orden.

<!-- codewolf:auto-context:start -->
# Estado automático más reciente

- Última actualización: 2026-07-18
- Último registro: contexto/66-runtime-multiarch-browser-whisper-docker.md
- Resumen: Los runtimes de agent-browser, Chromium Docker y whisper.cpp se preparan ahora por plataforma/arquitectura. Linux ARM64 usa Chromium del sistema, agent-browser conserva un manifest anti-reutilización cruzada y Whisper empaqueta libgomp portable Bookworm por x64/ARM64 para evitar incompatibilidades de glibc.
- Archivos del cambio: Dockerfile, entrypoint, descubrimiento/preparación/empaquetado de agent-browser, runtime de Whisper/libgomp, contexto y pruebas multi-arquitectura
<!-- codewolf:auto-context:end -->
