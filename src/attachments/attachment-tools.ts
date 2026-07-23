import type { ToolDefinition } from "../ai.ts";
import type { AttachmentManager } from "./attachment-manager.ts";
import type { MediaProcessorClient } from "../media-processing/client.ts";
import { isAllowedAudioMime, isAllowedImageMime, MAX_AUDIO_DURATION_SECONDS, MAX_AUDIO_SIZE_BYTES, MAX_IMAGE_SIZE_BYTES } from "../media.ts";
import { loadWhisperConfig } from "../whisper-config.ts";
import { debugInfo } from "../debug.ts";

export const ATTACHMENT_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "attachment_list",
      description: "Lista metadatos de los adjuntos recientes del usuario sin descargar su contenido.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "attachment_download",
      description: "Descarga un adjunto bajo demanda y lo guarda en el workdir. Úsalo solo cuando realmente necesites inspeccionar o conservar el archivo.",
      parameters: {
        type: "object",
        properties: {
          attachment_id: { type: "string", description: "ID ATT-...; si se omite usa el adjunto más reciente." },
          path: { type: "string", description: "Ruta relativa opcional dentro del workdir." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "attachment_ocr",
      description: "Descarga bajo demanda una imagen JPEG/PNG y extrae su texto localmente mediante OCR. No muestra mensajes de progreso al usuario; el resultado vuelve solo al modelo y queda en logs con --debug.",
      parameters: {
        type: "object",
        properties: { attachment_id: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "attachment_transcribe_audio",
      description: "Descarga bajo demanda una nota de voz OGG/Opus y la transcribe localmente con Whisper. No muestra mensajes de progreso al usuario; el resultado vuelve solo al modelo y queda en logs con --debug.",
      parameters: {
        type: "object",
        properties: { attachment_id: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
];

function describe(manager: AttachmentManager, jid: string): string {
  const list = manager.list(jid);
  if (!list.length) return "No hay adjuntos disponibles.";
  return list.slice(0, 12).map((item) => [
    `${item.id} · ${item.kind} · ${item.mimeType}`,
    `nombre=${item.fileName || "sin nombre"}`,
    `tamaño=${item.sizeBytes ?? "desconocido"}`,
    item.durationSeconds !== undefined ? `duración=${item.durationSeconds}s` : "",
    item.downloadedAt ? "descargado=sí" : "descargado=no",
  ].filter(Boolean).join(" · ")).join("\n");
}

export async function executeAttachmentTool(
  name: string,
  args: Record<string, unknown>,
  dependencies: { manager: AttachmentManager; media: MediaProcessorClient; jid: string },
): Promise<string> {
  const attachmentId = typeof args.attachment_id === "string" ? args.attachment_id.trim() : undefined;
  if (name === "attachment_list") return describe(dependencies.manager, dependencies.jid);

  if (name === "attachment_download") {
    const path = typeof args.path === "string" ? args.path.trim() : undefined;
    const downloaded = await dependencies.manager.downloadToWorkspace(dependencies.jid, attachmentId, path);
    debugInfo("attachments.tool", "download", { jid: dependencies.jid, attachmentId: downloaded.record.id, path: downloaded.path, bytes: downloaded.size });
    return `✅ Adjunto ${downloaded.record.id} descargado en ${downloaded.path} (${downloaded.size} bytes).`;
  }

  if (name === "attachment_ocr") {
    const record = dependencies.manager.resolve(dependencies.jid, attachmentId);
    const mimeType = record.mimeType.toLowerCase();
    if (record.kind !== "image" || !isAllowedImageMime(mimeType)) return "Error: attachment_ocr solo admite imágenes JPEG/PNG.";
    if (record.sizeBytes !== undefined && record.sizeBytes > MAX_IMAGE_SIZE_BYTES) return "Error: la imagen supera el límite de 10 MiB para OCR.";
    debugInfo("attachments.tool", "ocr_started", { jid: dependencies.jid, attachmentId: record.id, mimeType });
    const { bytes } = await dependencies.manager.getBytes(dependencies.jid, record.id);
    if (bytes.byteLength > MAX_IMAGE_SIZE_BYTES) return "Error: la imagen supera el límite real de 10 MiB para OCR.";
    const result = await dependencies.media.process("ocr-image", bytes, mimeType);
    debugInfo("attachments.tool", "ocr_completed", { jid: dependencies.jid, attachmentId: record.id, chars: result.text.length });
    return result.text.trim()
      ? `[OCR del adjunto ${record.id}]\n${result.text.trim()}`
      : `[OCR del adjunto ${record.id}] No se encontró texto legible.`;
  }

  if (name === "attachment_transcribe_audio") {
    const record = dependencies.manager.resolve(dependencies.jid, attachmentId);
    const mimeType = record.mimeType.toLowerCase();
    if (record.kind !== "audio" || !isAllowedAudioMime(mimeType)) return "Error: attachment_transcribe_audio solo admite notas de voz OGG/Opus.";
    const maxSeconds = loadWhisperConfig().maxAudioSeconds || MAX_AUDIO_DURATION_SECONDS;
    if (record.durationSeconds !== undefined && record.durationSeconds > maxSeconds) return `Error: el audio supera el límite de ${maxSeconds} segundos.`;
    if (record.sizeBytes !== undefined && record.sizeBytes > MAX_AUDIO_SIZE_BYTES) return "Error: el audio supera el límite de 12 MiB para transcripción.";
    debugInfo("attachments.tool", "transcription_started", { jid: dependencies.jid, attachmentId: record.id, mimeType, durationSeconds: record.durationSeconds });
    const { bytes } = await dependencies.manager.getBytes(dependencies.jid, record.id);
    if (bytes.byteLength > MAX_AUDIO_SIZE_BYTES) return "Error: el audio supera el límite real de 12 MiB para transcripción.";
    const result = await dependencies.media.process("transcribe-audio", bytes, mimeType);
    debugInfo("attachments.tool", "transcription_completed", { jid: dependencies.jid, attachmentId: record.id, chars: result.text.length, durationSeconds: result.durationSeconds });
    return result.text.trim()
      ? `[Transcripción del adjunto de audio ${record.id}]\n${result.text.trim()}`
      : `[Transcripción del adjunto de audio ${record.id}] No se identificó voz o texto.`;
  }

  return `Error: herramienta de adjuntos desconocida: ${name}`;
}
