#!/bin/bash
set -e

# ─── Persistent data directories ─────────────────────────────────
PERSISTENT_DIR="/data/persistent"

mkdir -p "$PERSISTENT_DIR"/{auth_info_baileys,contexts,uploads}

# ─── Permissions ─────────────────────────────────────────────────
chown -R appuser:appgroup "$PERSISTENT_DIR"

# ─── Detect --qr flag ────────────────────────────────────────────
# Si se pasa --qr (o cualquier flag) como único argumento,
# lo convertimos en el comando del binario completo.
if [ "${1#-}" != "$1" ]; then
  set -- /data/bot "$@"
fi

# ─── Drop privileges and execute CMD ─────────────────────────────
exec su-exec appuser "$@"
