#!/bin/bash
set -e

PERSISTENT_DIR="/data/persistent"
RUNTIME_HOME="$PERSISTENT_DIR/runtime-home"
XDG_RUNTIME_DIR_VALUE="$PERSISTENT_DIR/xdg-runtime"

mkdir -p \
  "$PERSISTENT_DIR/auth_info_baileys" \
  "$PERSISTENT_DIR/contexts" \
  "$RUNTIME_HOME/.cache" \
  "$RUNTIME_HOME/.config" \
  "$RUNTIME_HOME/.local/state" \
  "$XDG_RUNTIME_DIR_VALUE"

chown -R appuser:appgroup "$PERSISTENT_DIR"
chmod 700 "$XDG_RUNTIME_DIR_VALUE"

# agent-browser y Chromium necesitan ubicaciones escribibles para sockets,
# perfiles, caché y estado. No hacemos chown de /data completo: el binario y el
# runtime permanecen de solo lectura para appuser y todo el estado mutable vive
# dentro de persistent/.
export HOME="$RUNTIME_HOME"
export XDG_CACHE_HOME="$RUNTIME_HOME/.cache"
export XDG_CONFIG_HOME="$RUNTIME_HOME/.config"
export XDG_STATE_HOME="$RUNTIME_HOME/.local/state"
export XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR_VALUE"

# En las imágenes oficiales del proyecto Chromium se instala desde APT para la
# arquitectura de la imagen (amd64/arm64). Se permite sobrescribir la ruta.
if [ -z "${AGENT_BROWSER_EXECUTABLE_PATH:-}" ] && command -v chromium >/dev/null 2>&1; then
  export AGENT_BROWSER_EXECUTABLE_PATH="$(command -v chromium)"
fi

# Si se pasa --qr u otra opción como primer argumento, anteponer el binario.
if [ "${1#-}" != "$1" ]; then
  set -- /data/bot "$@"
fi

exec gosu appuser "$@"
