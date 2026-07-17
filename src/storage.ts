import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** Convierte un identificador externo en un segmento de ruta seguro. */
export function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9@._-]/g, "_");
}

/** Crea el directorio padre de un archivo cuando todavía no existe. */
export function ensureParentDirectory(filePath: string): void {
  const parent = dirname(filePath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}

/** Lee y deserializa JSON. Retorna null cuando el archivo no existe. */
export function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }
  return JSON.parse(readFileSync(filePath, "utf-8")) as T;
}

/**
 * Reemplaza un archivo usando un temporal en el mismo directorio.
 * En Windows aplica una rotación breve por backup cuando rename no puede
 * reemplazar directamente un destino existente.
 */
export function writeTextFileAtomically(filePath: string, content: string): void {
  ensureParentDirectory(filePath);

  const suffix = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  const tempPath = `${filePath}.${suffix}.tmp`;
  const backupPath = `${filePath}.${suffix}.bak`;

  writeFileSync(tempPath, content, {
    encoding: "utf-8",
    mode: 0o600,
  });

  try {
    try {
      renameSync(tempPath, filePath);
      return;
    } catch (replaceError) {
      if (!existsSync(filePath)) {
        throw replaceError;
      }

      renameSync(filePath, backupPath);
      try {
        renameSync(tempPath, filePath);
        rmSync(backupPath, { force: true });
      } catch (commitError) {
        if (!existsSync(filePath) && existsSync(backupPath)) {
          renameSync(backupPath, filePath);
        }
        throw commitError;
      }
    }
  } finally {
    rmSync(tempPath, { force: true });
    if (existsSync(filePath)) {
      rmSync(backupPath, { force: true });
    }
  }
}

/** Serializa y guarda JSON con reemplazo atómico. */
export function writeJsonFileAtomically(filePath: string, value: unknown): void {
  writeTextFileAtomically(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
