import { debugError, debugLog, debugWarn } from "../debug.ts";
import type { AgentExecutionLogContext } from "../agents/agent-types.ts";

interface QueueEntry<T> {
  id: number;
  label: string;
  operation: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  executionContext?: AgentExecutionLogContext;
}

let queueSequence = 0;
let active = 0;
let lastStartedAt = 0;
let wakeTimer: ReturnType<typeof setTimeout> | undefined;
const queue: QueueEntry<unknown>[] = [];

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function concurrencyLimit(): number {
  return integerEnv("LUNA_SEARCH_CONCURRENCY", 1, 1, 8);
}

function minimumIntervalMs(): number {
  return integerEnv("LUNA_SEARCH_MIN_INTERVAL_MS", 1_250, 0, 30_000);
}

function retryAttempts(): number {
  return integerEnv("LUNA_SEARCH_RETRY_ATTEMPTS", 3, 1, 6);
}

function retryBaseDelayMs(): number {
  return integerEnv("LUNA_SEARCH_RETRY_BASE_MS", 1_500, 250, 30_000);
}

function cancellationReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new Error("search-cancelled");
}

function removeAbortListener(entry: QueueEntry<unknown>): void {
  if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
}

function pump(): void {
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = undefined;
  }
  while (active < concurrencyLimit() && queue.length > 0) {
    const waitMs = Math.max(0, minimumIntervalMs() - (Date.now() - lastStartedAt));
    if (waitMs > 0) {
      wakeTimer = setTimeout(pump, waitMs);
      return;
    }

    const entry = queue.shift();
    if (!entry) return;
    removeAbortListener(entry);
    if (entry.signal?.aborted) {
      entry.reject(cancellationReason(entry.signal));
      continue;
    }

    active += 1;
    lastStartedAt = Date.now();
    debugLog("api-search.queue", "started", {
      backend: "api-search",
      ...entry.executionContext,
      action: "Solicitud API liberada desde la cola",
      queueId: entry.id,
      label: entry.label,
      active,
      pending: queue.length,
      concurrency: concurrencyLimit(),
      minimumIntervalMs: minimumIntervalMs(),
    });

    void entry.operation()
      .then(entry.resolve, entry.reject)
      .finally(() => {
        active -= 1;
        debugLog("api-search.queue", "released", {
          backend: "api-search",
          ...entry.executionContext,
          action: "Solicitud API finalizada y cupo liberado",
          queueId: entry.id,
          label: entry.label,
          active,
          pending: queue.length,
        });
        pump();
      });
  }
}

export function scheduleSearch<T>(label: string, operation: () => Promise<T>, signal?: AbortSignal, executionContext?: AgentExecutionLogContext): Promise<T> {
  if (signal?.aborted) return Promise.reject(cancellationReason(signal));
  return new Promise<T>((resolve, reject) => {
    const entry: QueueEntry<T> = {
      id: ++queueSequence,
      label,
      operation,
      resolve,
      reject,
      signal,
      executionContext,
    };
    if (signal) {
      entry.onAbort = () => {
        const index = queue.indexOf(entry as QueueEntry<unknown>);
        if (index >= 0) queue.splice(index, 1);
        reject(cancellationReason(signal));
        debugWarn("api-search.queue", "cancelled_while_waiting", {
          backend: "api-search",
          ...executionContext,
          action: "Búsqueda API cancelada mientras esperaba turno",
          queueId: entry.id,
          label,
          pending: queue.length,
        });
      };
      signal.addEventListener("abort", entry.onAbort, { once: true });
    }
    queue.push(entry as QueueEntry<unknown>);
    debugLog("api-search.queue", "queued", {
      backend: "api-search",
      ...executionContext,
      action: "Búsqueda API colocada en cola",
      queueId: entry.id,
      label,
      active,
      pending: queue.length,
      concurrency: concurrencyLimit(),
      minimumIntervalMs: minimumIntervalMs(),
    });
    pump();
  });
}

function isConfigurationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no hay motores habilitados|no hay motores configurados|configúralos|setup-search|api key/i.test(message);
}

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /cancel(?:led|ado)|operación cancelada|search-cancelled/i.test(message);
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancellationReason(signal));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = (): void => {
      clearTimeout(timer);
      reject(cancellationReason(signal));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function runSearchWithRetry<T>(
  label: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
  executionContext?: AgentExecutionLogContext,
): Promise<T> {
  const attempts = retryAttempts();
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      debugLog("api-search.retry", "attempt", { backend: "api-search", ...executionContext, action: `Intento API ${attempt}/${attempts}`, label, attempt, attempts });
      const result = await scheduleSearch(`${label}#${attempt}`, operation, signal, executionContext);
      if (attempt > 1) debugInfoCompat(label, attempt, executionContext);
      return result;
    } catch (error) {
      lastError = error;
      if (isCancellation(error, signal) || isConfigurationError(error) || attempt >= attempts) {
        debugError("api-search.retry", "exhausted", error, { backend: "api-search", ...executionContext, action: "Se agotaron los reintentos API", label, attempt, attempts });
        throw error;
      }
      const delayMs = retryBaseDelayMs() * (2 ** (attempt - 1));
      debugWarn("api-search.retry", "will_retry", {
        backend: "api-search",
        ...executionContext,
        action: "La búsqueda API falló; se reintentará",
        label,
        attempt,
        attempts,
        delayMs,
        error: error instanceof Error ? error.message : String(error),
      });
      await wait(delayMs, signal);
    }
  }
  throw lastError;
}

function debugInfoCompat(label: string, attempt: number, executionContext?: AgentExecutionLogContext): void {
  debugLog("api-search.retry", "recovered", { backend: "api-search", ...executionContext, action: "Búsqueda API recuperada tras reintento", label, attempt });
}
