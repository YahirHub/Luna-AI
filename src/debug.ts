const REDACTED = "[REDACTED]";

function enabledFromEnv(): boolean {
  const value = process.env.LUNA_DEBUG?.trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off" && value !== "no";
}

function verboseFromEnv(): boolean {
  const value = process.env.LUNA_DEBUG_VERBOSE?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

function redactString(value: string): string {
  return value
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, `$1${REDACTED}`)
    .replace(/([?&](?:api[_-]?key|key|token|secret|password)=)[^&\s]+/gi, `$1${REDACTED}`)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|api[_-]?key-[A-Za-z0-9_-]{16,}|key-[A-Za-z0-9_-]{24,})\b/gi, REDACTED);
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
      if (/api[_-]?key|authorization|cookie|password|passphrase|secret|token|credential/i.test(key)) {
        output[key] = REDACTED;
      } else {
        output[key] = sanitize(entry, depth + 1);
      }
    }
    return output;
  }
  return String(value);
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
  const line = `[LUNA ${level}] ${JSON.stringify(record)}`;
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
