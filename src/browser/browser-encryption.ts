import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const BROWSER_ENCRYPTION_KEY_PATTERN = /^[a-f0-9]{64}$/i;

function ensureMode600(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows aplica sus propias ACL.
  }
}

function readValidatedKey(path: string): string {
  const key = readFileSync(path, "utf8").trim();
  if (!BROWSER_ENCRYPTION_KEY_PATTERN.test(key)) {
    throw new Error(
      `La clave de cifrado del navegador en ${path} es inválida. No se regeneró automáticamente para evitar perder acceso a credenciales existentes.`,
    );
  }
  ensureMode600(path);
  return key.toLowerCase();
}

/**
 * Lee una clave AES-256 persistente o la crea una sola vez.
 *
 * Una clave existente pero corrupta nunca se reemplaza silenciosamente: hacerlo
 * volvería indescifrables todos los perfiles guardados con la clave anterior.
 */
export function loadOrCreateBrowserEncryptionKey(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) return readValidatedKey(path);

  const key = randomBytes(32).toString("hex");
  try {
    writeFileSync(path, `${key}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    ensureMode600(path);
    return key;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "EEXIST") return readValidatedKey(path);
    throw error;
  }
}
