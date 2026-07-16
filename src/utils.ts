import { dirname } from "node:path";

/**
 * Obtiene el directorio base de la aplicación.
 * En modo compilado (--compile), usa el directorio del .exe.
 * En modo desarrollo, usa el working directory.
 */
export function getAppDir(): string {
  // En modo compilado, Bun.main es una ruta virtual como "/$bunfs/root/..."
  // En modo desarrollo, Bun.main es la ruta real del archivo de entrada
  if (typeof Bun !== "undefined" && Bun.main.includes("/$bunfs/")) {
    return dirname(process.execPath);
  }
  // Modo desarrollo: usar CWD
  return process.cwd();
}

/**
 * Normaliza un número de teléfono al formato E.164 sin el signo +.
 * Elimina espacios, guiones, paréntesis y el prefijo + si existe.
 */
export function normalizePhoneNumber(raw: string): string {
  let cleaned = raw.replace(/[\s\-()]/g, "");

  // Remove leading + if present
  if (cleaned.startsWith("+")) {
    cleaned = cleaned.slice(1);
  }

  return cleaned;
}

/**
 * Verifica que el número tenga solo dígitos y una longitud válida (7-15).
 */
export function isValidPhoneNumber(phone: string): boolean {
  return /^\d{7,15}$/.test(phone);
}

/**
 * Retraso con promesa.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
