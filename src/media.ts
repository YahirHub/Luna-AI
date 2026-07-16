import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import type { WAMessage } from "@whiskeysockets/baileys";
import { getAppDir } from "./utils.ts";

const UPLOADS_DIR = join(getAppDir(), "persistent", "uploads");

/** Tipos MIME permitidos para descarga. */
const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

/** Tamaño máximo en bytes (10 MB). */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/** Asegura que la carpeta de uploads exista. */
function ensureUploadsDir(): void {
  if (!existsSync(UPLOADS_DIR)) {
    mkdirSync(UPLOADS_DIR, { recursive: true });
  }
}

/** Retorna true si el tipo MIME es una imagen permitida. */
export function isAllowedImageMime(
  mimeType: string,
): mimeType is AllowedMimeType {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType);
}

/** Retorna true si el tamaño no excede el límite. */
export function isWithinSizeLimit(sizeBytes: number): boolean {
  return sizeBytes <= MAX_FILE_SIZE_BYTES;
}

/**
 * Descarga la imagen de un mensaje de WhatsApp y la guarda en uploads/.
 * Retorna la ruta del archivo o null si no se pudo guardar.
 */
export async function downloadAndSaveImage(
  message: WAMessage,
): Promise<string | null> {
  const imageMessage = message.message?.imageMessage;

  if (!imageMessage) {
    return null;
  }

  const mimeType = imageMessage.mimetype ?? "image/jpeg";

  if (!isAllowedImageMime(mimeType)) {
    console.warn(`[media] Tipo MIME no permitido: ${mimeType}`);
    return null;
  }

  const fileSizeBytes = imageMessage.fileLength;

  if (fileSizeBytes !== undefined && fileSizeBytes !== null) {
    const size: number =
      typeof fileSizeBytes === "object"
        ? (fileSizeBytes as { toNumber(): number }).toNumber()
        : Number(fileSizeBytes);

    if (Number.isFinite(size) && !isWithinSizeLimit(size)) {
      console.warn(
        `[media] Archivo demasiado grande: ${size} bytes (máx ${MAX_FILE_SIZE_BYTES})`,
      );
      return null;
    }
  }

  ensureUploadsDir();

  const buffer = await downloadMediaMessage(message, "buffer", {});

  const extension = mimeType.split("/")[1] ?? "jpg";
  const filename = `${Date.now()}_${message.key.id ?? "unknown"}.${extension}`;
  const filePath = join(UPLOADS_DIR, filename);

  writeFileSync(filePath, new Uint8Array(buffer));
  console.log(`[media] Imagen guardada: ${filePath}`);

  return filePath;
}
