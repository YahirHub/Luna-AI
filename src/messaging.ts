import type { WASocket } from "@whiskeysockets/baileys";
import { delay } from "./utils.ts";
import { debugError, debugInfo, debugLog, debugWarn } from "./debug.ts";

export interface ContinuousTypingSession {
  refresh: () => Promise<void>;
  stop: () => Promise<void>;
}

type OutboundContent = Parameters<WASocket["sendMessage"]>[1];

interface PendingMessage {
  id: number;
  jid: string;
  content: OutboundContent;
  minDelayMs: number;
  maxDelayMs: number;
  attempts: number;
  createdAt: number;
  resolve: (status: "sent" | "queued") => void;
  reject: (error: unknown) => void;
}

export interface ResilientSendOptions {
  minDelayMs?: number;
  maxDelayMs?: number;
  /**
   * Cuando hay conexión activa espera confirmación de envío. Si WhatsApp ya
   * está desconectado, siempre retorna "queued" inmediatamente para no frenar
   * agentes ni flujos de negocio; la cola se vacía al reconectar.
   */
  waitForDelivery?: boolean;
}

let activeSocket: WASocket | null = null;
let socketStateKnown = false;
let sequence = 0;
let flushing = false;
const pending: PendingMessage[] = [];

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function defaultMinDelayMs(): number {
  return intEnv("LUNA_WHATSAPP_MIN_DELAY_MS", 1_200, 0, 30_000);
}

function defaultMaxDelayMs(): number {
  return Math.max(
    defaultMinDelayMs(),
    intEnv("LUNA_WHATSAPP_MAX_DELAY_MS", 2_800, 0, 60_000),
  );
}

function sendRetryAttempts(): number {
  return intEnv("LUNA_WHATSAPP_SEND_RETRY_ATTEMPTS", 3, 1, 8);
}

function randomDelay(minDelayMs: number, maxDelayMs: number): number {
  const min = Math.max(0, minDelayMs);
  const max = Math.max(min, maxDelayMs);
  return min + Math.floor(Math.random() * (max - min + 1));
}

function isConnectionClosedError(error: unknown): boolean {
  const record = error as {
    output?: { statusCode?: number };
    data?: unknown;
    message?: string;
    name?: string;
  } | null;
  const status = record?.output?.statusCode;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return status === 408 || status === 428 || status === 503 || /connection\s*(?:is\s*)?closed|socket.*closed|not connected|connection lost|timed out|unexpected close/i.test(message);
}

async function presence(sock: WASocket | null, state: "composing" | "paused", jid: string): Promise<void> {
  if (!sock) return;
  try {
    await sock.sendPresenceUpdate(state, jid);
  } catch {
    // La presencia es best-effort. Un fallo nunca debe romper el envío real.
  }
}

async function simulateTyping(sock: WASocket, item: PendingMessage): Promise<void> {
  await presence(sock, "composing", item.jid);
  const waitMs = randomDelay(item.minDelayMs, item.maxDelayMs);
  if (waitMs > 0) await delay(waitMs);
}

async function flushQueue(): Promise<void> {
  if (flushing || !activeSocket) return;
  flushing = true;
  try {
    while (activeSocket && pending.length > 0) {
      const item = pending[0];
      const sock = activeSocket;
      if (!item || !sock) break;

      try {
        debugLog("whatsapp.queue", "sending", {
          messageId: item.id,
          jid: item.jid,
          pending: pending.length,
          attempt: item.attempts + 1,
        });
        await simulateTyping(sock, item);
        await sock.sendMessage(item.jid, item.content);
        await presence(sock, "paused", item.jid);
        pending.shift();
        item.resolve("sent");
        debugInfo("whatsapp.queue", "sent", {
          messageId: item.id,
          jid: item.jid,
          pending: pending.length,
          queuedForMs: Date.now() - item.createdAt,
        });
      } catch (error) {
        await presence(sock, "paused", item.jid);
        item.attempts += 1;

        if (isConnectionClosedError(error)) {
          // El socket pasado por llamadas antiguas puede quedar inválido antes
          // de que Baileys emita connection.update. Se conserva el mensaje y se
          // espera al siguiente setMessagingSocket(sock).
          activeSocket = null;
          // Liberar al flujo que esperaba este envío: el mensaje permanece en
          // la cola y será reintentado al reconectar, pero la tarea no queda
          // bloqueada esperando indefinidamente a WhatsApp.
          item.resolve("queued");
          debugWarn("whatsapp.queue", "connection_lost_message_preserved", {
            messageId: item.id,
            jid: item.jid,
            pending: pending.length,
            error: error instanceof Error ? error.message : String(error),
          });
          break;
        }

        if (item.attempts < sendRetryAttempts()) {
          const backoff = Math.min(1_000 * 2 ** (item.attempts - 1), 10_000);
          debugWarn("whatsapp.queue", "send_retry", {
            messageId: item.id,
            jid: item.jid,
            attempt: item.attempts,
            maxAttempts: sendRetryAttempts(),
            backoffMs: backoff,
            error: error instanceof Error ? error.message : String(error),
          });
          await delay(backoff);
          continue;
        }

        pending.shift();
        item.reject(error);
        debugError("whatsapp.queue", "send_failed_permanently", error, {
          messageId: item.id,
          jid: item.jid,
          attempts: item.attempts,
          pending: pending.length,
        });
      }
    }
  } finally {
    flushing = false;
    // Si entró otro mensaje justo cuando terminaba el loop, continuar.
    if (activeSocket && pending.length > 0) void flushQueue();
  }
}

/**
 * Actualiza el socket que puede realizar entregas. Cuando recibe un nuevo
 * socket después de una reconexión, vacía automáticamente la cola pendiente.
 */
export function setMessagingSocket(sock: WASocket | null): void {
  socketStateKnown = true;
  activeSocket = sock;
  if (sock) {
    debugInfo("whatsapp.queue", "socket_available", { pending: pending.length });
    void flushQueue();
  } else {
    debugWarn("whatsapp.queue", "socket_unavailable", { pending: pending.length });
  }
}

export function getPendingWhatsAppMessageCount(): number {
  return pending.length;
}

/**
 * Única ruta recomendada para mensajes salientes. Si la conexión se perdió,
 * conserva el mensaje en memoria y lo entrega automáticamente al reconectar.
 * Todos los mensajes pasan por una breve simulación de escritura.
 */
export async function sendWhatsAppMessage(
  sock: WASocket,
  jid: string,
  content: OutboundContent,
  options: ResilientSendOptions = {},
): Promise<"sent" | "queued"> {
  // Compatibilidad con pruebas y usos aislados donde no existe connection.ts.
  if (!socketStateKnown && !activeSocket) activeSocket = sock;

  const connectedAtEnqueue = Boolean(activeSocket);
  let resolveDelivery!: (status: "sent" | "queued") => void;
  let rejectDelivery!: (error: unknown) => void;
  const delivered = new Promise<"sent" | "queued">((resolve, reject) => {
    resolveDelivery = resolve;
    rejectDelivery = reject;
  });
  // Evita un unhandled rejection cuando quien llama eligió no esperar entrega.
  void delivered.catch(() => undefined);

  const item: PendingMessage = {
    id: ++sequence,
    jid,
    content,
    minDelayMs: options.minDelayMs ?? defaultMinDelayMs(),
    maxDelayMs: options.maxDelayMs ?? defaultMaxDelayMs(),
    attempts: 0,
    createdAt: Date.now(),
    resolve: resolveDelivery,
    reject: rejectDelivery,
  };
  pending.push(item);
  debugInfo("whatsapp.queue", "queued", {
    messageId: item.id,
    jid,
    connected: connectedAtEnqueue,
    pending: pending.length,
  });
  void flushQueue();

  // Durante desconexión no bloqueamos el proceso, el lock de conversación ni
  // los subagentes. La entrega ocurrirá al reconectar.
  if (!connectedAtEnqueue || options.waitForDelivery === false) return "queued";

  try {
    return await delivered;
  } catch (error) {
    // Solo errores no relacionados con conectividad llegan aquí. Las caídas de
    // socket preservan el mensaje y no se propagan al flujo de negocio.
    if (isConnectionClosedError(error)) return "queued";
    throw error;
  }
}

/**
 * Mantiene visible el estado "escribiendo" durante una operación real larga.
 * Durante una desconexión se convierte en no-op y se reanuda cuando el flujo
 * vuelva a solicitar refresh con un socket activo.
 */
export async function startContinuousTyping(
  sock: WASocket,
  jid: string,
  refreshIntervalMs = 8_000,
): Promise<ContinuousTypingSession> {
  let active = true;
  let refreshInFlight = false;

  const refresh = async (): Promise<void> => {
    if (!active || refreshInFlight) return;
    refreshInFlight = true;
    try {
      const target = activeSocket ?? (!socketStateKnown ? sock : null);
      await presence(target, "composing", jid);
    } finally {
      refreshInFlight = false;
    }
  };

  await refresh();
  const timer = setInterval(() => {
    void refresh();
  }, Math.max(2_000, refreshIntervalMs));
  (timer as unknown as { unref?: () => void }).unref?.();

  return {
    refresh,
    stop: async () => {
      if (!active) return;
      active = false;
      clearInterval(timer);
      const target = activeSocket ?? (!socketStateKnown ? sock : null);
      await presence(target, "paused", jid);
    },
  };
}

/** Envía texto mediante la cola resiliente, simulando escritura. */
export async function sendWithTyping(
  sock: WASocket,
  jid: string,
  text: string,
  minDelayMs = 3_000,
  maxDelayMs = 5_000,
): Promise<void> {
  await sendWhatsAppMessage(sock, jid, { text }, {
    minDelayMs,
    maxDelayMs,
    // Si la conexión ya está caída, la función retorna al dejarlo en cola.
    // Si está disponible, preservamos el comportamiento histórico de esperar
    // la confirmación de sendMessage.
    waitForDelivery: true,
  });
}
