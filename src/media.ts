import type { TransportIncomingMedia, TransportIncomingMessage } from "./transports/types.ts";

const IMAGE_MIME_TYPES = ["image/jpeg", "image/png"] as const;
const AUDIO_MIME_PREFIXES = ["audio/ogg", "audio/opus"] as const;

export const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_AUDIO_SIZE_BYTES = 12 * 1024 * 1024;
export const MAX_AUDIO_DURATION_SECONDS = 120;

export type DownloadedMedia = {
  bytes: Uint8Array;
  mimeType: string;
};

export function isAllowedImageMime(mimeType: string): boolean {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(mimeType.toLowerCase());
}

export function isAllowedAudioMime(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase();
  return AUDIO_MIME_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix};`));
}

export function isWithinSizeLimit(sizeBytes: number, maxBytes = MAX_IMAGE_SIZE_BYTES): boolean {
  return Number.isFinite(sizeBytes) && sizeBytes >= 0 && sizeBytes <= maxBytes;
}

export function getMediaKind(message: TransportIncomingMessage): "image" | "audio" | null {
  return message.media?.kind === "image" || message.media?.kind === "audio"
    ? message.media.kind
    : null;
}

export function getMediaCaption(message: TransportIncomingMessage): string {
  return message.media?.caption?.trim() ?? "";
}

async function downloadValidatedMedia(
  media: TransportIncomingMedia,
  maxBytes: number,
): Promise<DownloadedMedia> {
  if (typeof media.sizeBytes === "number" && !isWithinSizeLimit(media.sizeBytes, maxBytes)) {
    throw new Error(`El archivo supera el límite de ${Math.floor(maxBytes / 1024 / 1024)} MB.`);
  }

  const bytes = new Uint8Array(await media.download());
  if (!isWithinSizeLimit(bytes.byteLength, maxBytes)) {
    throw new Error(`El archivo supera el límite real de ${Math.floor(maxBytes / 1024 / 1024)} MB.`);
  }
  return { bytes, mimeType: media.mimeType };
}

export async function downloadImageForOcr(message: TransportIncomingMessage): Promise<DownloadedMedia> {
  const image = message.media;
  if (!image || image.kind !== "image") throw new Error("El mensaje no contiene una imagen.");
  const mimeType = (image.mimeType || "image/jpeg").toLowerCase();
  if (!isAllowedImageMime(mimeType)) {
    throw new Error("El OCR local solo admite imágenes JPEG y PNG.");
  }
  return downloadValidatedMedia({ ...image, mimeType }, MAX_IMAGE_SIZE_BYTES);
}

export async function downloadAudioForTranscription(
  message: TransportIncomingMessage,
  maxDurationSeconds = MAX_AUDIO_DURATION_SECONDS,
): Promise<DownloadedMedia> {
  const audio = message.media;
  if (!audio || audio.kind !== "audio") throw new Error("El mensaje no contiene audio.");
  const mimeType = (audio.mimeType || "audio/ogg; codecs=opus").toLowerCase();
  if (!isAllowedAudioMime(mimeType)) {
    throw new Error("La transcripción local solo admite notas de voz OGG/Opus.");
  }
  if (typeof audio.durationSeconds === "number" && audio.durationSeconds > maxDurationSeconds) {
    throw new Error(`El audio supera el límite de ${maxDurationSeconds} segundos.`);
  }
  return downloadValidatedMedia({ ...audio, mimeType }, MAX_AUDIO_SIZE_BYTES);
}

export function buildAudioContextText(transcript: string): string {
  return `[Transcripción de audio generada por el sistema]\n${transcript.trim()}`;
}

export function buildImageContextText(ocrText: string, caption = ""): string {
  const normalizedCaption = caption.trim();
  const normalizedOcr = ocrText.trim();
  const parts: string[] = [];

  if (normalizedCaption) {
    parts.push(`[Mensaje del usuario adjunto a la imagen]\n${normalizedCaption}`);
  }

  parts.push(
    normalizedOcr
      ? `[Texto extraído de la imagen por el sistema]\n${normalizedOcr}`
      : "[La extracción de texto de la imagen no produjo contenido legible]",
  );

  return parts.join("\n\n");
}
