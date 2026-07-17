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

/**
 * Retorna la hora actual en CDMX con todos los formatos necesarios.
 * Función unificada — usar esta en lugar de implementar propia.
 */
export function getMexicoCityNow(): {
  hour: number;
  minute: number;
  ymd: string;
  ts: number;
  dayOfWeek: number;
  text: string;
} {
  const now = new Date();

  const formatter = new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Mexico_City",
    hour: "numeric",
    minute: "numeric",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "0";
  const hour = parseInt(get("hour"), 10);
  const minute = parseInt(get("minute"), 10);
  const year = get("year");
  const month = get("month").padStart(2, "0");
  const day = get("day").padStart(2, "0");
  const ymd = `${year}-${month}-${day}`;

  // Día de la semana en inglés para mapeo numérico
  const dayName = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Mexico_City",
    weekday: "long",
  }).format(now);
  const dayMap: Record<string, number> = {
    Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
    Thursday: 4, Friday: 5, Saturday: 6,
  };
  const dayOfWeek = dayMap[dayName] ?? 0;

  // Texto formateado legible tipo "Hoy es miércoles... Son las 15:30"
  const dateText = new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Mexico_City",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(now);
  const timeText = new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Mexico_City",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const text = `Hoy es ${dateText}. Son las ${timeText} (hora Ciudad de Mexico, America/Mexico_City).`;

  return {
    hour,
    minute,
    ymd,
    ts: hour * 60 + minute,
    dayOfWeek,
    text,
  };
}

/** Valida una fecha calendario real en formato YYYY-MM-DD. */
export function isValidYmdDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
