const REDACTED = "[REDACTED]";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
};

function enabledFromEnv(): boolean {
  const value = process.env.LUNA_DEBUG?.trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off" && value !== "no";
}

function verboseFromEnv(): boolean {
  const value = process.env.LUNA_DEBUG_VERBOSE?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

function colorsEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  const value = process.env.LUNA_DEBUG_COLORS?.trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off" && value !== "no";
}

function redactString(value: string): string {
  return value
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, `$1${REDACTED}`)
    .replace(/([?&](?:api[_-]?key|key|token|secret|password)=)[^&\s]+/gi, `$1${REDACTED}`)
    // Evitar falsos positivos como "anthropic-api-pricing". Solo se ocultan
    // prefijos de secretos conocidos o formatos inequívocos.
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, REDACTED)
    .replace(/\btvly-[A-Za-z0-9_-]{16,}\b/g, REDACTED)
    .replace(/\bgsk_[A-Za-z0-9_-]{16,}\b/g, REDACTED)
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, REDACTED);
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[MAX_DEPTH]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    const redacted = redactString(value);
    if (!verboseFromEnv() && redacted.length > 2_000) {
      return `${redacted.slice(0, 2_000)}…[${redacted.length - 2_000} chars omitted]`;
    }
    return redacted;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
      cause: sanitize(value.cause, depth + 1),
    };
  }
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/api[_-]?key|authorization|cookie|password|passphrase|secret|credential/i.test(key)) {
        output[key] = REDACTED;
      } else if (/^token$/i.test(key) && typeof entry === "string" && entry.length >= 12) {
        output[key] = REDACTED;
      } else {
        output[key] = sanitize(entry, depth + 1);
      }
    }
    return output;
  }
  return String(value);
}

function scopeColor(scope: string, event: string): string {
  const normalized = `${scope}.${event}`.toLowerCase();
  if (normalized.includes("search")) return ANSI.brightCyan;
  if (normalized.includes("read_url") || normalized.includes("fetch")) return ANSI.brightMagenta;
  if (normalized.includes("agent")) return ANSI.brightBlue;
  if (normalized.includes("whatsapp") || normalized.includes("messaging")) return ANSI.brightYellow;
  if (normalized.includes("ai") || normalized.includes("llm")) return ANSI.brightGreen;
  if (normalized.includes("alarm") || normalized.includes("reminder")) return ANSI.magenta;
  return ANSI.gray;
}

function levelColor(level: "DEBUG" | "INFO" | "WARN" | "ERROR"): string {
  if (level === "ERROR") return ANSI.brightRed;
  if (level === "WARN") return ANSI.brightYellow;
  if (level === "INFO") return ANSI.brightGreen;
  return ANSI.gray;
}

function write(level: "DEBUG" | "INFO" | "WARN" | "ERROR", scope: string, event: string, data?: unknown): void {
  if (!enabledFromEnv()) return;
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    scope,
    event,
  };
  if (data !== undefined) record.data = sanitize(data);

  const json = JSON.stringify(record);
  const prefix = `[LUNA ${level}]`;
  const line = colorsEnabled()
    ? `${levelColor(level)}${ANSI.bold}${prefix}${ANSI.reset} ${scopeColor(scope, event)}${scope}.${event}${ANSI.reset} ${ANSI.dim}${json}${ANSI.reset}`
    : `${prefix} ${json}`;

  if (level === "ERROR") console.error(line);
  else if (level === "WARN") console.warn(line);
  else console.log(line);
}

export function debugLog(scope: string, event: string, data?: unknown): void {
  write("DEBUG", scope, event, data);
}

export function debugInfo(scope: string, event: string, data?: unknown): void {
  write("INFO", scope, event, data);
}

export function debugWarn(scope: string, event: string, data?: unknown): void {
  write("WARN", scope, event, data);
}

export function debugError(scope: string, event: string, error: unknown, data?: unknown): void {
  write("ERROR", scope, event, {
    ...(data && typeof data === "object" ? data as Record<string, unknown> : { context: data }),
    error,
  });
}

export function isDebugEnabled(): boolean {
  return enabledFromEnv();
}
