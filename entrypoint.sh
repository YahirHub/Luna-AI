#!/bin/bash
set -e

PERSISTENT_DIR="/data/persistent"
mkdir -p "$PERSISTENT_DIR"/{auth_info_baileys,contexts}
chown -R appuser:appgroup "$PERSISTENT_DIR"

# Si se pasa --qr u otra opción como primer argumento, anteponer el binario.
if [ "${1#-}" != "$1" ]; then
  set -- /data/bot "$@"
fi

exec gosu appuser "$@"
