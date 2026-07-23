import { downloadMediaMessage, type WASocket, type WAMessage } from "@whiskeysockets/baileys";
import { delay } from "../../utils.ts";
import { debugError, debugInfo, debugLog, debugWarn } from "../../debug.ts";
import type {
  MessagingTransport,
  TransportDeliveryStatus,
  TransportIncomingMessage,
  TransportOutboundContent,
  TransportSendOptions,
} from "../types.ts";

type BaileysContent = Parameters<WASocket["sendMessage"]>[1];
interface PendingMessage {
  id: number;
  conversationId: string;
  content: TransportOutboundContent;
  minDelayMs: number;
  maxDelayMs: number;
  attempts: number;
  createdAt: number;
  resolve: (status: TransportDeliveryStatus) => void;
  reject: (error: unknown) => void;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
function closed(error: unknown): boolean {
  const record = error as { output?: { statusCode?: number } } | null;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return [408, 428, 503].includes(record?.output?.statusCode ?? 0) || /connection\s*(?:is\s*)?closed|socket.*closed|not connected|connection lost|timed out|unexpected close/i.test(message);
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "bigint") {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : undefined;
  }
  if (value && typeof value === "object" && "toNumber" in value) {
    const converted = (value as { toNumber(): number }).toNumber();
    return Number.isFinite(converted) ? converted : undefined;
  }
  return undefined;
}


function unwrapMessageRecord(value: unknown): Record<string, Record<string, unknown> | undefined> {
  let current = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const wrapperKeys = ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "viewOnceMessageV2Extension", "documentWithCaptionMessage"];
  for (let depth = 0; depth < 5; depth += 1) {
    let next: Record<string, unknown> | null = null;
    for (const key of wrapperKeys) {
      const wrapper = current[key];
      if (!wrapper || typeof wrapper !== "object") continue;
      const nested = (wrapper as Record<string, unknown>).message;
      if (nested && typeof nested === "object") { next = nested as Record<string, unknown>; break; }
    }
    if (!next) break;
    current = next;
  }
  return current as Record<string, Record<string, unknown> | undefined>;
}

export class BaileysTransport implements MessagingTransport {
  readonly id = "baileys";
  private socket: WASocket | null = null;
  private sequence = 0;
  private flushing = false;
  private readonly pending: PendingMessage[] = [];

  get connected(): boolean { return this.socket !== null; }
  get pendingCount(): number { return this.pending.length; }

  attachSocket(socket: WASocket | null): void {
    this.socket = socket;
    if (socket) {
      debugInfo("transport.baileys.queue", "socket_available", { pending: this.pending.length });
      void this.flush();
    } else debugWarn("transport.baileys.queue", "socket_unavailable", { pending: this.pending.length });
  }

  toIncoming(raw: WAMessage): TransportIncomingMessage {
    const message = raw.message;
    const messageRecord = unwrapMessageRecord(message);
    const candidates: Array<[TransportIncomingMessage["mediaKind"], Record<string, unknown> | undefined]> = [
      ["image", messageRecord.imageMessage],
      ["audio", messageRecord.audioMessage],
      ["video", messageRecord.videoMessage ?? messageRecord.ptvMessage],
      ["document", messageRecord.documentMessage],
      ["sticker", messageRecord.stickerMessage],
    ];
    let selected = candidates.find(([, node]) => Boolean(node));
    if (!selected) {
      const knownKeys = new Set(["imageMessage", "audioMessage", "videoMessage", "ptvMessage", "documentMessage", "stickerMessage"]);
      const fallback = Object.entries(messageRecord).find(([key, node]) => {
        if (knownKeys.has(key) || !node || typeof node !== "object") return false;
        return typeof node.mimetype === "string" || node.fileLength !== undefined;
      });
      if (fallback) selected = ["other", fallback[1]];
    }
    const mediaKind = selected?.[0] ?? null;
    const mediaNode = selected?.[1];
    const caption = typeof mediaNode?.caption === "string" ? mediaNode.caption : "";
    const rootText = typeof (messageRecord.conversation as unknown) === "string" ? messageRecord.conversation as unknown as string : "";
    const extendedText = messageRecord.extendedTextMessage && typeof messageRecord.extendedTextMessage.text === "string" ? messageRecord.extendedTextMessage.text : "";
    const text = rootText || extendedText || caption;
    const size = numericValue(mediaNode?.fileLength);
    const seconds = numericValue(mediaNode?.seconds);
    const fileName = typeof mediaNode?.fileName === "string" ? mediaNode.fileName : undefined;
    const mimeType = typeof mediaNode?.mimetype === "string" ? mediaNode.mimetype : undefined;
    return {
      id: raw.key.id ?? crypto.randomUUID(),
      conversationId: raw.key.remoteJid ?? "",
      fromSelf: raw.key.fromMe === true,
      text,
      mediaKind,
      caption,
      raw,
      mediaMimeType: mimeType,
      mediaFileName: fileName,
      mediaSizeBytes: Number.isFinite(size) ? size : undefined,
      mediaDurationSeconds: Number.isFinite(seconds) ? seconds : undefined,
      downloadMedia: mediaKind ? async () => new Uint8Array(await downloadMediaMessage(raw, "buffer", {})) : undefined,
    };
  }

  async sendPresence(conversationId: string, state: "composing" | "paused"): Promise<void> {
    try { await this.socket?.sendPresenceUpdate(state, conversationId); } catch { /* best effort */ }
  }

  async markRead(message: TransportIncomingMessage): Promise<void> {
    const raw = message.raw as WAMessage;
    if (!this.socket || !raw?.key) return;
    await this.socket.readMessages([raw.key]);
  }

  async deleteMessage(message: TransportIncomingMessage): Promise<void> {
    const raw = message.raw as WAMessage;
    if (!this.socket || !raw?.key || !message.conversationId) return;
    await this.socket.sendMessage(message.conversationId, { delete: raw.key });
  }

  async send(conversationId: string, content: TransportOutboundContent, options: TransportSendOptions = {}): Promise<TransportDeliveryStatus> {
    const connected = this.connected;
    let resolveDelivery!: (status: TransportDeliveryStatus) => void;
    let rejectDelivery!: (error: unknown) => void;
    const delivered = new Promise<TransportDeliveryStatus>((resolve, reject) => { resolveDelivery = resolve; rejectDelivery = reject; });
    void delivered.catch(() => undefined);
    const item: PendingMessage = {
      id: ++this.sequence,
      conversationId,
      content,
      minDelayMs: options.minDelayMs ?? intEnv("LUNA_WHATSAPP_MIN_DELAY_MS", 1200, 0, 30000),
      maxDelayMs: options.maxDelayMs ?? intEnv("LUNA_WHATSAPP_MAX_DELAY_MS", 2800, 0, 60000),
      attempts: 0,
      createdAt: Date.now(),
      resolve: resolveDelivery,
      reject: rejectDelivery,
    };
    this.pending.push(item);
    debugInfo("transport.baileys.queue", "queued", { messageId: item.id, conversationId, connected, pending: this.pending.length });
    void this.flush();
    if (!connected || options.waitForDelivery === false) return "queued";
    try { return await delivered; } catch (error) { if (closed(error)) return "queued"; throw error; }
  }

  private async flush(): Promise<void> {
    if (this.flushing || !this.socket) return;
    this.flushing = true;
    try {
      while (this.socket && this.pending.length) {
        const item = this.pending[0]!;
        const socket = this.socket;
        try {
          debugLog("transport.baileys.queue", "sending", { messageId: item.id, conversationId: item.conversationId, pending: this.pending.length, attempt: item.attempts + 1 });
          await this.sendPresence(item.conversationId, "composing");
          const wait = item.minDelayMs + Math.floor(Math.random() * (Math.max(item.minDelayMs, item.maxDelayMs) - item.minDelayMs + 1));
          if (wait) await delay(wait);
          await socket.sendMessage(item.conversationId, item.content as BaileysContent);
          await this.sendPresence(item.conversationId, "paused");
          this.pending.shift();
          item.resolve("sent");
          debugInfo("transport.baileys.queue", "sent", { messageId: item.id, conversationId: item.conversationId, pending: this.pending.length, queuedForMs: Date.now() - item.createdAt });
        } catch (error) {
          await this.sendPresence(item.conversationId, "paused");
          item.attempts += 1;
          if (closed(error)) {
            this.socket = null;
            item.resolve("queued");
            debugWarn("transport.baileys.queue", "connection_lost_message_preserved", { messageId: item.id, conversationId: item.conversationId, pending: this.pending.length });
            break;
          }
          const max = intEnv("LUNA_WHATSAPP_SEND_RETRY_ATTEMPTS", 3, 1, 8);
          if (item.attempts < max) { await delay(Math.min(1000 * 2 ** (item.attempts - 1), 10000)); continue; }
          this.pending.shift();
          item.reject(error);
          debugError("transport.baileys.queue", "send_failed_permanently", error, { messageId: item.id, attempts: item.attempts });
        }
      }
    } finally {
      this.flushing = false;
      if (this.socket && this.pending.length) void this.flush();
    }
  }
}
