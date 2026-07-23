import type { LunaModule } from "../types.ts";

export const ATTACHMENTS_MODULE: LunaModule = {
  id: "attachments",
  name: "Adjuntos",
  description: "Descarga e inspección bajo demanda de archivos enviados por el usuario",
  category: "media",
  access: "authenticated",
  scope: "user",
  tools: [
    { name: "attachment_list" },
    { name: "attachment_download" },
    { name: "attachment_ocr" },
    { name: "attachment_transcribe_audio" },
  ],
  prompt: {
    summary: "Los archivos entrantes se entregan primero como metadata; decide si necesitas descargarlos, aplicar OCR o transcribir audio.",
    patterns: [/\[ADJUNTO DISPONIBLE/iu, /\b(?:adjunto|archivo|imagen|foto|audio|nota de voz|documento)\b/iu],
    instructions: [
      "Los adjuntos NO se descargan ni inspeccionan automáticamente. No inventes su contenido basándote en nombre, MIME o caption.",
      "Usa attachment_download solo si necesitas el archivo físico en el workdir. Para una imagen JPEG/PNG que requiera leer texto usa attachment_ocr; para una nota de voz OGG/Opus usa attachment_transcribe_audio.",
      "Las tools de OCR/transcripción son silenciosas para el usuario: no anuncies 'transcribiendo' ni 'extrayendo texto'; simplemente usa la herramienta cuando sea necesaria.",
      "Si la solicitud puede responderse sin descargar el archivo, no lo descargues.",
    ],
  },
};
