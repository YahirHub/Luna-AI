import type { WASocket, WAMessage } from "@whiskeysockets/baileys";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { delay } from "../../utils.ts";
import { debugError, debugInfo, debugLog, debugWarn } from "../../debug.ts";
import type {
  MessagingTransport,
  TransportActivitySession,
  TransportDeliveryStatus,
  TransportIncomingMedia,
  TransportIncomingMessage,
  TransportOutboundMessage,
  TransportSendOptions,
} from "../types.ts";

interface PendingMessage {
  id: number;
  conversationId: string;
  message: TransportOutboundMessage;
  minDelayMs: number;
  maxDelayMs: number;
  attempts: number;
  createdAt: number;
  resolve: (status: TransportDeliveryStatus) => void;
  reject: (error: unknown) => void;
}

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
  const record = error as { output?: { statusCode?: number }; message?: string } | null;
  const status = record?.output?.statusCode;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return status === 408 || status === 428 || status === 503 ||
    /connection\s*(?:is\s*)?closed|socket.*closed|not connected|connection lost|timed out|unexpected close/i.test(message);
}

function numericMessageValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object" && "toNumber" in value) {
    const converted = (value as { toNumber(): number }).toNumber();
    return Number.isFinite(converted) ? converted : undefined;
  }
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : undefined;
}

export function isWhatsAppGroupJid(jid: string | null | undefined): boolean {
  return typeof jid === "string" && jid.toLowerCase().endsWith("@g.us");
}

function getText(message: WAMessage): string {
  return (
    message.message?.conversation ??
    message.message?.extendedTextMessage?.text ??
    message.message?.imageMessage?.caption ??
    ""
  );
}

function getIncomingMedia(message: WAMessage): TransportIncomingMedia | undefined {
  const image = message.message?.imageMessage;
  if (image) {
    return {
      kind: "image",
      mimeType: (image.mimetype ?? "image/jpeg").toLowerCase(),
      caption: image.caption?.trim() ?? "",
      sizeBytes: numericMessageValue(image.fileLength),
      download: async () => new Uint8Array(await downloadMediaMessage(message, "buffer", {})),
    };
  }

  const audio = message.message?.audioMessage;
  if (audio) {
    return {
      kind: "audio",
      mimeType: (audio.mimetype ?? "audio/ogg; codecs=opus").toLowerCase(),
      sizeBytes: numericMessageValue(audio.fileLength),
      durationSeconds: numericMessageValue(audio.seconds),
      download: async () => new Uint8Array(await downloadMediaMessage(message, "buffer", {})),
    };
  }

  const video = message.message?.videoMessage;
  if (video) {
    return {
      kind: "video",
      mimeType: (video.mimetype ?? "video/mp4").toLowerCase(),
      caption: video.caption?.trim() ?? "",
      sizeBytes: numericMessageValue(video.fileLength),
      durationSeconds: numericMessageValue(video.seconds),
      download: async () => new Uint8Array(await downloadMediaMessage(message, "buffer", {})),
    };
  }

  const document = message.message?.documentMessage;
  if (document) {
    return {
      kind: "document",
      mimeType: (document.mimetype ?? "application/octet-stream").toLowerCase(),
      fileName: document.fileName ?? undefined,
      sizeBytes: numericMessageValue(document.fileLength),
      download: async () => new Uint8Array(await downloadMediaMessage(message, "buffer", {})),
    };
  }

  return undefined;
}

export function normalizeBaileysMessage(message: WAMessage): TransportIncomingMessage | null {
  const chatId = message.key.remoteJid;
  if (!chatId) return null;
  const participant = message.key.participant ?? chatId;
  return {
    transportId: "baileys",
    // Se conserva el JID como conversationId para mantener compatibles auth,
    // memoria, contextos y workdirs existentes.
    conversationId: chatId,
    chatId,
    senderId: participant,
    messageId: message.key.id ?? "",
    fromSelf: message.key.fromMe === true,
    isGroup: isWhatsAppGroupJid(chatId),
    text: getText(message),
    media: getIncomingMedia(message),
    native: message,
  };
}

/**
 * Adaptador de salida Baileys. Toda la política propia de WhatsApp queda aquí:
 * cola resiliente, presencia composing/paused y conversión de archivos.
 */
export class BaileysTransport implements MessagingTransport {
  readonly id = "baileys";
  readonly label = "WhatsApp (Baileys)";

  private socket: WASocket | null = null;
  private sequence = 0;
  private flushing = false;
  private readonly pending: PendingMessage[] = [];

  setSocket(sock: WASocket | null): void {
    this.socket = sock;
    if (sock) {
      debugInfo("transport.baileys.queue", "socket_available", { pending: this.pending.length });
      void this.flushQueue();
    } else {
      debugWarn("transport.baileys.queue", "socket_unavailable", { pending: this.pending.length });
    }
  }

  getPendingCount(): number {
    return this.pending.length;
  }

  private async presence(state: "composing" | "paused", conversationId: string): Promise<void> {
    const sock = this.socket;
    if (!sock) return;
    try {
      await sock.sendPresenceUpdate(state, conversationId);
    } catch {
      // Best-effort: un fallo de presencia nunca bloquea un mensaje real.
    }
  }

  private toBaileysContent(message: TransportOutboundMessage): Parameters<WASocket["sendMessage"]>[1] {
    if (message.kind === "text") return { text: message.text };

    const content = Buffer.from(message.bytes);
    const asDocument = message.mode === "document" || content.length > 10 * 1024 * 1024;
    if (!asDocument && message.mimeType.startsWith("image/")) {
      return { image: content, caption: message.caption || undefined, mimetype: message.mimeType };
    }
    if (!asDocument && message.mimeType.startsWith("audio/")) {
      return { audio: content, mimetype: message.mimeType, ptt: false };
    }
    if (!asDocument && message.mimeType.startsWith("video/")) {
      return { video: content, caption: message.caption || undefined, mimetype: message.mimeType };
    }
    return {
      document: content,
      mimetype: message.mimeType,
      fileName: message.fileName,
      caption: message.caption || undefined,
    };
  }

  private async simulateTyping(item: PendingMessage): Promise<void> {
    await this.presence("composing", item.conversationId);
    const waitMs = randomDelay(item.minDelayMs, item.maxDelayMs);
    if (waitMs > 0) await delay(waitMs);
  }

  private async flushQueue(): Promise<void> {
    if (this.flushing || !this.socket) return;
    this.flushing = true;
    try {
      while (this.socket && this.pending.length > 0) {
        const item = this.pending[0];
        const sock = this.socket;
        if (!item || !sock) break;

        try {
          debugLog("transport.baileys.queue", "sending", {
            messageId: item.id,
            conversationId: item.conversationId,
            pending: this.pending.length,
            attempt: item.attempts + 1,
          });
          // Cualquier mensaje enviado por Baileys simula escritura desde aquí.
          await this.simulateTyping(item);
          await sock.sendMessage(item.conversationId, this.toBaileysContent(item.message));
          await this.presence("paused", item.conversationId);
          this.pending.shift();
          item.resolve("sent");
          debugInfo("transport.baileys.queue", "sent", {
            messageId: item.id,
            conversationId: item.conversationId,
            pending: this.pending.length,
            queuedForMs: Date.now() - item.createdAt,
          });
        } catch (error) {
          await this.presence("paused", item.conversationId);
          item.attempts += 1;

          if (isConnectionClosedError(error)) {
            this.socket = null;
            item.resolve("queued");
            debugWarn("transport.baileys.queue", "connection_lost_message_preserved", {
              messageId: item.id,
              conversationId: item.conversationId,
              pending: this.pending.length,
              error: error instanceof Error ? error.message : String(error),
            });
            break;
          }

          if (item.attempts < sendRetryAttempts()) {
            const backoff = Math.min(1_000 * 2 ** (item.attempts - 1), 10_000);
            debugWarn("transport.baileys.queue", "send_retry", {
              messageId: item.id,
              conversationId: item.conversationId,
              attempt: item.attempts,
              maxAttempts: sendRetryAttempts(),
              backoffMs: backoff,
              error: error instanceof Error ? error.message : String(error),
            });
            await delay(backoff);
            continue;
          }

          this.pending.shift();
          item.reject(error);
          debugError("transport.baileys.queue", "send_failed_permanently", error, {
            messageId: item.id,
            conversationId: item.conversationId,
            attempts: item.attempts,
            pending: this.pending.length,
          });
        }
      }
    } finally {
      this.flushing = false;
      if (this.socket && this.pending.length > 0) void this.flushQueue();
    }
  }

  async send(
    conversationId: string,
    message: TransportOutboundMessage,
    options: TransportSendOptions = {},
  ): Promise<TransportDeliveryStatus> {
    const connectedAtEnqueue = Boolean(this.socket);
    let resolveDelivery!: (status: TransportDeliveryStatus) => void;
    let rejectDelivery!: (error: unknown) => void;
    const delivered = new Promise<TransportDeliveryStatus>((resolve, reject) => {
      resolveDelivery = resolve;
      rejectDelivery = reject;
    });
    void delivered.catch(() => undefined);

    const item: PendingMessage = {
      id: ++this.sequence,
      conversationId,
      message,
      minDelayMs: options.minDelayMs ?? defaultMinDelayMs(),
      maxDelayMs: options.maxDelayMs ?? defaultMaxDelayMs(),
      attempts: 0,
      createdAt: Date.now(),
      resolve: resolveDelivery,
      reject: rejectDelivery,
    };
    this.pending.push(item);
    debugInfo("transport.baileys.queue", "queued", {
      messageId: item.id,
      conversationId,
      connected: connectedAtEnqueue,
      pending: this.pending.length,
    });
    void this.flushQueue();

    if (!connectedAtEnqueue || options.waitForDelivery === false) return "queued";
    try {
      return await delivered;
    } catch (error) {
      if (isConnectionClosedError(error)) return "queued";
      throw error;
    }
  }

  async startActivity(conversationId: string, refreshIntervalMs = 8_000): Promise<TransportActivitySession> {
    let active = true;
    let refreshInFlight = false;
    const refresh = async (): Promise<void> => {
      if (!active || refreshInFlight) return;
      refreshInFlight = true;
      try {
        await this.presence("composing", conversationId);
      } finally {
        refreshInFlight = false;
      }
    };

    await refresh();
    const timer = setInterval(() => void refresh(), Math.max(2_000, refreshIntervalMs));
    (timer as unknown as { unref?: () => void }).unref?.();

    return {
      refresh,
      stop: async () => {
        if (!active) return;
        active = false;
        clearInterval(timer);
        await this.presence("paused", conversationId);
      },
    };
  }

  async markRead(message: TransportIncomingMessage): Promise<void> {
    const sock = this.socket;
    const native = message.native as WAMessage | undefined;
    if (!sock || !native?.key) return;
    try {
      await sock.readMessages([native.key]);
    } catch {
      // Best-effort.
    }
  }

  async deleteMessage(message: TransportIncomingMessage): Promise<void> {
    const sock = this.socket;
    const native = message.native as WAMessage | undefined;
    if (!sock || !native?.key?.remoteJid) return;
    try {
      await sock.sendMessage(native.key.remoteJid, { delete: native.key });
    } catch {
      // La plataforma puede impedir borrar mensajes ajenos.
    }
  }
}
