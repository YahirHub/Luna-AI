import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentExecutionContext } from "./agents/execution-context.ts";
import { formatProjectTimestamp, getAppDir, getProjectTimeZone } from "./utils.ts";

const REDACTED = "[REDACTED]";
const DEFAULT_ERROR_LOG_MAX_BYTES = 1024 * 1024;
const ERROR_LOG_TRIM_TARGET_BYTES = 800 * 1024;

const ANSI = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", gray: "\x1b[90m",
  brightRed: "\x1b[91m", brightGreen: "\x1b[92m", brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m", brightMagenta: "\x1b[95m", brightCyan: "\x1b[96m",
};

function truthy(value: string | undefined): boolean {
  return ["1", "true", "on", "yes"].includes(value?.trim().toLowerCase() ?? "");
}

function enabledFromRuntime(): boolean {
  if (process.argv.includes("--debug")) return true;
  return truthy(process.env.LUNA_DEBUG);
}

function verboseFromEnv(): boolean { return truthy(process.env.LUNA_DEBUG_VERBOSE); }

function colorsEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  const value = process.env.LUNA_DEBUG_COLORS?.trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off" && value !== "no";
}

function errorLogMaxBytes(): number {
  const configured = Number.parseInt(process.env.LUNA_ERROR_LOG_MAX_BYTES ?? "", 10);
  return Number.isFinite(configured) && configured >= 64 * 1024 ? configured : DEFAULT_ERROR_LOG_MAX_BYTES;
}

function errorLogPath(): string {
  const configured = process.env.LUNA_ERROR_LOG_PATH?.trim();
  return configured || join(getAppDir(), "persistent", "logs", "errors.log");
}

function redactString(value: string): string {
  return value
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, `$1${REDACTED}`)
    .replace(/([?&](?:api[_-]?key|key|token|secret|password)=)[^&\s]+/gi, `$1${REDACTED}`)
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
    if (!verboseFromEnv() && redacted.length > 2_000) return `${redacted.slice(0, 2_000)}…[${redacted.length - 2_000} chars omitted]`;
    return redacted;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) return {
    name: value.name,
    message: redactString(value.message),
    stack: value.stack ? redactString(value.stack) : undefined,
    cause: sanitize(value.cause, depth + 1),
  };
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/api[_-]?key|authorization|cookie|password|passphrase|secret|credential/i.test(key)) output[key] = REDACTED;
      else if (/^token$/i.test(key) && typeof entry === "string" && entry.length >= 12) output[key] = REDACTED;
      else output[key] = sanitize(entry, depth + 1);
    }
    return output;
  }
  return String(value);
}

function scopeColor(scope: string, event: string): string {
  const normalized = `${scope}.${event}`.toLowerCase();
  if (normalized.includes("attachment") || normalized.includes("media") || normalized.includes("whisper") || normalized.includes("ocr")) return ANSI.brightCyan;
  if (normalized.includes("search")) return ANSI.brightCyan;
  if (normalized.includes("read_url") || normalized.includes("fetch") || normalized.includes("browser")) return ANSI.brightMagenta;
  if (normalized.includes("agent")) return ANSI.brightBlue;
  if (normalized.includes("whatsapp") || normalized.includes("messaging") || normalized.includes("transport")) return ANSI.brightYellow;
  if (normalized.includes("ai") || normalized.includes("llm")) return ANSI.brightGreen;
  return ANSI.gray;
}

function levelColor(level: "DEBUG" | "INFO" | "WARN" | "ERROR"): string {
  if (level === "ERROR") return ANSI.brightRed;
  if (level === "WARN") return ANSI.brightYellow;
  if (level === "INFO") return ANSI.brightGreen;
  return ANSI.gray;
}

function rotateErrorLog(path: string, maxBytes: number): void {
  try {
    if (!existsSync(path) || statSync(path).size <= maxBytes) return;
    const data = readFileSync(path);
    const target = Math.min(ERROR_LOG_TRIM_TARGET_BYTES, Math.floor(maxBytes * 0.8));
    let start = Math.max(0, data.length - target);
    while (start < data.length && data[start] !== 0x0a) start += 1;
    if (start < data.length) start += 1;
    writeFileSync(path, data.subarray(start));
  } catch {
    // El logger nunca debe tumbar Luna por un problema de disco/log.
  }
}

function persistError(record: Record<string, unknown>): void {
  try {
    const path = errorLogPath();
    mkdirSync(dirname(path), { recursive: true });
    const line = `${JSON.stringify(record)}\n`;
    appendFileSync(path, line, "utf8");
    rotateErrorLog(path, errorLogMaxBytes());
  } catch {
    // Best effort: no recursión mediante console/debug.
  }
}

function write(level: "DEBUG" | "INFO" | "WARN" | "ERROR", scope: string, event: string, data?: unknown): void {
  const now = new Date();
  const record: Record<string, unknown> = {
    ts: now.toISOString(),
    local_ts: formatProjectTimestamp(now),
    timezone: getProjectTimeZone(),
    level,
    scope,
    event,
  };
  const agentContext = getAgentExecutionContext();
  const enriched = agentContext
    ? { ...(data && typeof data === "object" ? data as Record<string, unknown> : data === undefined ? {} : { value: data }), ...agentContext }
    : data;
  if (enriched !== undefined) record.data = sanitize(enriched);

  // Los errores siempre quedan registrados físicamente aunque --debug esté apagado.
  if (level === "ERROR") persistError(record);
  if (!enabledFromRuntime()) return;

  const json = JSON.stringify(record);
  const prefix = `[${record.local_ts} ${record.timezone}] [LUNA ${level}]`;
  const line = colorsEnabled()
    ? `${levelColor(level)}${ANSI.bold}${prefix}${ANSI.reset} ${scopeColor(scope, event)}${scope}.${event}${ANSI.reset} ${ANSI.dim}${json}${ANSI.reset}`
    : `${prefix} ${json}`;

  if (level === "ERROR") console.error(line);
  else if (level === "WARN") console.warn(line);
  else console.log(line);
}

export function debugLog(scope: string, event: string, data?: unknown): void { write("DEBUG", scope, event, data); }
export function debugInfo(scope: string, event: string, data?: unknown): void { write("INFO", scope, event, data); }
export function debugWarn(scope: string, event: string, data?: unknown): void { write("WARN", scope, event, data); }
export function debugError(scope: string, event: string, error: unknown, data?: unknown): void {
  write("ERROR", scope, event, {
    ...(data && typeof data === "object" ? data as Record<string, unknown> : { context: data }),
    error,
  });
}
export function isDebugEnabled(): boolean { return enabledFromRuntime(); }
export function getErrorLogFilePath(): string { return errorLogPath(); }
