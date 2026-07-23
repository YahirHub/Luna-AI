import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { TransportIncomingMessage, TransportMediaKind } from "../transports/types.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import { sanitizePathSegment } from "../storage.ts";
import { debugInfo } from "../debug.ts";

export interface IncomingAttachment {
  id: string;
  jid: string;
  messageId: string;
  kind: TransportMediaKind;
  mimeType: string;
  fileName?: string;
  sizeBytes?: number;
  durationSeconds?: number;
  caption?: string;
  receivedAt: string;
  downloadedAt?: string;
  cachePath?: string;
  download: () => Promise<Uint8Array>;
}

const DEFAULT_MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_ATTACHMENTS_PER_USER = 24;

function maxAttachmentBytes(): number {
  const configured = Number.parseInt(process.env.LUNA_ATTACHMENT_MAX_BYTES ?? "", 10);
  return Number.isFinite(configured) && configured >= 1024 * 1024 ? configured : DEFAULT_MAX_ATTACHMENT_BYTES;
}

function attachmentTtlMs(): number {
  const configured = Number.parseInt(process.env.LUNA_ATTACHMENT_TTL_MS ?? "", 10);
  return Number.isFinite(configured) && configured >= 60_000 ? configured : DEFAULT_TTL_MS;
}

function extensionFromMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
  const map: Record<string, string> = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
    "audio/ogg": ".ogg", "audio/opus": ".opus", "audio/mpeg": ".mp3", "audio/wav": ".wav",
    "video/mp4": ".mp4", "video/webm": ".webm", "application/pdf": ".pdf",
    "application/zip": ".zip", "text/plain": ".txt", "application/json": ".json",
  };
  return map[normalized] ?? "";
}

function safeFileName(record: IncomingAttachment): string {
  const original = record.fileName?.trim();
  if (original) {
    const cleanBase = sanitizePathSegment(basename(original)).replace(/^\.+/, "");
    if (cleanBase) return cleanBase;
  }
  return `${record.kind}-${record.id}${extensionFromMime(record.mimeType)}`;
}

function formatBytes(value?: number): string {
  if (!Number.isFinite(value)) return "desconocido";
  const bytes = value ?? 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export class AttachmentManager {
  private readonly entries = new Map<string, IncomingAttachment[]>();
  private readonly workspace: WorkspaceManager;

  constructor(workspace: WorkspaceManager) { this.workspace = workspace; }

  private userCacheDir(jid: string): string {
    const dir = join(this.workspace.getUserDir(jid), "attachment-cache");
    mkdirSync(dir, { recursive: true });
    const cutoff = Date.now() - attachmentTtlMs();
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = join(dir, entry.name);
        try { if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true }); } catch { /* best effort */ }
      }
    } catch { /* best effort */ }
    return dir;
  }

  private prune(jid: string): void {
    const now = Date.now();
    const ttl = attachmentTtlMs();
    const current = this.entries.get(jid) ?? [];
    const keep: IncomingAttachment[] = [];
    for (const item of current) {
      const age = now - Date.parse(item.receivedAt);
      if (Number.isFinite(age) && age > ttl) {
        if (item.cachePath) {
          try { rmSync(item.cachePath, { force: true }); } catch { /* best effort */ }
        }
        continue;
      }
      keep.push(item);
    }
    const limited = keep.slice(-MAX_ATTACHMENTS_PER_USER);
    for (const item of keep.slice(0, Math.max(0, keep.length - limited.length))) {
      if (item.cachePath) {
        try { rmSync(item.cachePath, { force: true }); } catch { /* best effort */ }
      }
    }
    this.entries.set(jid, limited);
  }

  register(jid: string, message: TransportIncomingMessage): IncomingAttachment {
    if (!message.mediaKind || !message.downloadMedia) throw new Error("El mensaje no contiene un archivo descargable.");
    this.prune(jid);
    const record: IncomingAttachment = {
      id: `ATT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      jid,
      messageId: message.id,
      kind: message.mediaKind,
      mimeType: message.mediaMimeType?.trim() || "application/octet-stream",
      fileName: message.mediaFileName?.trim() || undefined,
      sizeBytes: message.mediaSizeBytes,
      durationSeconds: message.mediaDurationSeconds,
      caption: message.caption?.trim() || undefined,
      receivedAt: new Date().toISOString(),
      download: message.downloadMedia,
    };
    const list = this.entries.get(jid) ?? [];
    list.push(record);
    this.entries.set(jid, list.slice(-MAX_ATTACHMENTS_PER_USER));
    debugInfo("attachments", "registered", {
      jid, attachmentId: record.id, kind: record.kind, mimeType: record.mimeType,
      fileName: record.fileName, sizeBytes: record.sizeBytes, durationSeconds: record.durationSeconds,
    });
    return record;
  }

  list(jid: string): IncomingAttachment[] {
    this.prune(jid);
    return [...(this.entries.get(jid) ?? [])].reverse();
  }

  resolve(jid: string, attachmentId?: string): IncomingAttachment {
    const list = this.list(jid);
    if (list.length === 0) throw new Error("No hay adjuntos disponibles en esta conversación.");
    if (!attachmentId?.trim()) return list[0]!;
    const normalized = attachmentId.trim().toLowerCase();
    const found = list.find((item) => item.id.toLowerCase() === normalized);
    if (!found) throw new Error(`No existe el adjunto ${attachmentId}. Usa attachment_list para consultar los disponibles.`);
    return found;
  }

  async getBytes(jid: string, attachmentId?: string): Promise<{ record: IncomingAttachment; bytes: Uint8Array }> {
    const record = this.resolve(jid, attachmentId);
    const maxBytes = maxAttachmentBytes();
    if (record.sizeBytes !== undefined && record.sizeBytes > maxBytes) {
      throw new Error(`El archivo supera el límite de descarga de ${(maxBytes / 1024 / 1024).toFixed(0)} MiB.`);
    }
    if (record.cachePath && existsSync(record.cachePath)) {
      return { record, bytes: new Uint8Array(readFileSync(record.cachePath)) };
    }

    debugInfo("attachments", "download_started", { jid, attachmentId: record.id, kind: record.kind, sizeBytes: record.sizeBytes });
    const bytes = await record.download();
    if (bytes.byteLength > maxBytes) throw new Error(`El archivo supera el límite real de ${(maxBytes / 1024 / 1024).toFixed(0)} MiB.`);
    const cachePath = join(this.userCacheDir(jid), `${record.id}-${safeFileName(record)}`);
    writeFileSync(cachePath, bytes);
    record.cachePath = cachePath;
    record.downloadedAt = new Date().toISOString();
    debugInfo("attachments", "download_completed", { jid, attachmentId: record.id, bytes: bytes.byteLength, cachePath });
    return { record, bytes };
  }

  async downloadToWorkspace(jid: string, attachmentId?: string, requestedPath?: string): Promise<{ record: IncomingAttachment; path: string; size: number }> {
    const { record, bytes } = await this.getBytes(jid, attachmentId);
    const defaultPath = `inbox/attachments/${record.id}/${safeFileName(record)}`;
    const relativePath = requestedPath?.trim() || defaultPath;
    const target = this.workspace.resolvePath(jid, relativePath, { allowDirectory: false });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    return { record, path: this.workspace.relativePath(jid, target), size: bytes.byteLength };
  }

  buildIncomingContext(record: IncomingAttachment, userText = ""): string {
    const lines = [
      "[ADJUNTO DISPONIBLE — NO DESCARGADO AUTOMÁTICAMENTE]",
      `ID: ${record.id}`,
      `Tipo: ${record.kind}`,
      `MIME: ${record.mimeType}`,
      `Nombre: ${record.fileName || "sin nombre informado"}`,
      `Tamaño: ${formatBytes(record.sizeBytes)}`,
    ];
    if (record.durationSeconds !== undefined) lines.push(`Duración: ${record.durationSeconds}s`);
    lines.push(
      "El contenido todavía NO ha sido descargado ni inspeccionado.",
      "Decide si necesitas descargarlo. Usa attachment_download para conservarlo en el workdir, attachment_ocr para extraer texto de una imagen o attachment_transcribe_audio para transcribir una nota de voz.",
      "No inventes el contenido del archivo si no utilizas una herramienta que lo inspeccione.",
    );
    const normalizedText = userText.trim();
    if (normalizedText) return `${normalizedText}\n\n${lines.join("\n")}`;
    return lines.join("\n");
  }

  buildRuntimeContext(jid: string): string {
    const list = this.list(jid).slice(0, 8);
    if (list.length === 0) return "No hay adjuntos disponibles.";
    return [
      "Adjuntos recientes disponibles bajo demanda:",
      ...list.map((item) => `- ${item.id}: ${item.kind}, ${item.mimeType}, ${item.fileName || "sin nombre"}, ${formatBytes(item.sizeBytes)}${item.downloadedAt ? ", descargado previamente" : ", sin descargar"}`),
    ].join("\n");
  }
}
