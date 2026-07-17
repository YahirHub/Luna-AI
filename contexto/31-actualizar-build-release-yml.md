<!-- codewolf:auto-context:record -->
# 023 — Actualizar build-release.yml

# Fecha

2026-07-16

# Objetivo

Actualizar build-release.yml.

# Archivos importantes modificados

- .github/workflows/build-release.yml

# Soluciones implementadas

- actions/checkout@v4 agregado al job release
- set -euo pipefail para detección temprana de errores

