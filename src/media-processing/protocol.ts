export type MediaJobType = "transcribe-audio" | "ocr-image";

/**
 * Mensaje enviado al proceso multimedia aislado.
 * Bun IPC usa structured clone, por lo que Uint8Array viaja directamente
 * sin base64 ni archivos temporales.
 */
export type MediaWorkerRequest = {
  id: string;
  type: MediaJobType;
  mimeType: string;
  bytes: Uint8Array;
};

export type MediaWorkerResponse =
  | { id: string; type: "result"; text: string; durationSeconds?: number }
  | { id: string; type: "error"; error: string };
