import type { TransportIncomingMessage, TransportMediaKind } from "./transports/types.ts";

const IMAGE_MIME_TYPES = ["image/jpeg", "image/png"] as const;
const AUDIO_MIME_PREFIXES = ["audio/ogg", "audio/opus"] as const;

export const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_AUDIO_SIZE_BYTES = 12 * 1024 * 1024;
export const MAX_AUDIO_DURATION_SECONDS = 120;

export type DownloadedMedia = {
  bytes: Uint8Array;
  mimeType: string;
};

function numericMessageValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object" && "toNumber" in value) {
    const converted = (value as { toNumber(): number }).toNumber();
    return Number.isFinite(converted) ? converted : null;
  }
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : null;
}

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

export function getMediaKind(message: TransportIncomingMessage): TransportMediaKind | null { return message.mediaKind; }


export function getMediaCaption(message: TransportIncomingMessage): string { return message.caption.trim(); }

async function downloadValidatedMedia(
  message: TransportIncomingMessage,
  mimeType: string,
  declaredSize: unknown,
  maxBytes: number,
): Promise<DownloadedMedia> {
  const numericSize = numericMessageValue(declaredSize);
  if (numericSize !== null && !isWithinSizeLimit(numericSize, maxBytes)) {
    throw new Error(`El archivo supera el límite de ${Math.floor(maxBytes / 1024 / 1024)} MB.`);
  }

  if (!message.downloadMedia) throw new Error("El transporte no permite descargar este archivo.");
  const bytes = await message.downloadMedia();
  if (!isWithinSizeLimit(bytes.byteLength, maxBytes)) {
    throw new Error(`El archivo supera el límite real de ${Math.floor(maxBytes / 1024 / 1024)} MB.`);
  }
  return { bytes, mimeType };
}

export async function downloadImageForOcr(message: TransportIncomingMessage): Promise<DownloadedMedia> {
  if (message.mediaKind !== "image") throw new Error("El mensaje no contiene una imagen.");
  const mimeType = (message.mediaMimeType ?? "image/jpeg").toLowerCase();
  if (!isAllowedImageMime(mimeType)) {
    throw new Error("El OCR local solo admite imágenes JPEG y PNG.");
  }
  return downloadValidatedMedia(message, mimeType, message.mediaSizeBytes, MAX_IMAGE_SIZE_BYTES);
}

export async function downloadAudioForTranscription(
  message: TransportIncomingMessage,
  maxDurationSeconds = MAX_AUDIO_DURATION_SECONDS,
): Promise<DownloadedMedia> {
  if (message.mediaKind !== "audio") throw new Error("El mensaje no contiene audio.");
  const mimeType = (message.mediaMimeType ?? "audio/ogg; codecs=opus").toLowerCase();
  if (!isAllowedAudioMime(mimeType)) {
    throw new Error("La transcripción local solo admite notas de voz OGG/Opus.");
  }
  const duration = numericMessageValue(message.mediaDurationSeconds);
  if (duration !== null && duration > maxDurationSeconds) {
    throw new Error(`El audio supera el límite de ${maxDurationSeconds} segundos.`);
  }
  return downloadValidatedMedia(message, mimeType, message.mediaSizeBytes, MAX_AUDIO_SIZE_BYTES);
}

export function buildAudioContextText(transcript: string): string {
  return `[Transcripción de audio generada por el sistema]\n${transcript.trim()}`;
}

export function buildImageContextText(ocrText: string, caption = ""): string {
  const normalizedCaption = caption.trim();
  const normalizedOcr = ocrText.trim();
  const parts: string[] = [];

  // El texto escrito por el usuario debe conservarse primero para que el
  // asistente entienda la intención de la imagen antes de leer el OCR.
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
