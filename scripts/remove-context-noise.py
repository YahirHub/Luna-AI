#!/usr/bin/env python3
"""Elimina registros de contexto duplicados/espurios y el informe ARM64 obsoleto.

Uso desde la raíz del proyecto:
  python scripts/remove-context-noise.py --dry-run
  python scripts/remove-context-noise.py

Es compatible con Windows, Linux y macOS y solo toca las rutas enumeradas aquí.
"""

from __future__ import annotations

import argparse
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
TARGETS = (
    "contexto/19-actualizar-logica-del-bot.md",
    "contexto/20-personalidad-luna-y-memoria-persistente.md",
    "contexto/25-implementar-el-cambio-necesario-para-actualizar-impl.md",
    "contexto/26-recordatorios-listar-editar-eliminar-y-feedback-whatsapp.md",
    "contexto/064-actualizar-nul.md",
    "contexto/065-actualizar-dockerfile.md",
    "contexto/066-actualizar-implementacion-del-proyecto.md",
    "contexto/066-implementar-el-cambio-necesario-para-actualizar-impl.md",
    "contexto/067-implementar-el-cambio-necesario-para-actualizar-impl.md",
    "contexto/068-actualizar-informe-md.md",
    "contexto/069-actualizar-nul.md",
    "informe.md",
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Muestra qué se eliminaría sin modificar archivos.")
    args = parser.parse_args()

    removed = 0
    for relative in TARGETS:
        target = PROJECT_ROOT / relative
        if not target.exists():
            print(f"[omitido] {relative}")
            continue
        if args.dry_run:
            print(f"[eliminaría] {relative}")
        else:
            target.unlink()
            print(f"[eliminado] {relative}")
        removed += 1

    action = "detectados" if args.dry_run else "eliminados"
    print(f"{removed} archivo(s) {action}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
