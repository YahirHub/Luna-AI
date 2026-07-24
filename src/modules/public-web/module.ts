import type { LunaModule } from "../types.ts";

export const PUBLIC_WEB_MODULE: LunaModule = {
  id: "public-web",
  name: "Web pública directa",
  description: "Búsqueda, inspección y descarga HTTP directa de contenido público sin subagentes",
  category: "internet",
  access: "authenticated",
  scope: "global",
  tools: [
    { name: "public_media_search" },
    { name: "public_web_extract_urls" },
    { name: "public_media_download" },
  ],
  prompt: {
    summary: "Resuelve búsquedas y descargas públicas por HTTP/API antes de gastar un browser-agent.",
    keywords: [
      "archive.org", "internet archive", "wikimedia", "commons", "imagen", "imagenes", "imágenes",
      "video", "vídeo", "audio", "mp4", "webm", "descarga", "descargar", "mandamelo", "mándamelo",
    ],
    patterns: [
      /\b(?:busca|encuentra|descarga|manda|envia|envía).{0,100}\b(?:video|vídeo|imagen|foto|audio|mp4|webm)\b/iu,
      /\b(?:archive\.org|commons\.wikimedia\.org|wikimedia commons)\b/iu,
    ],
    instructions: [
      "Para contenido público descargable evita subagentes cuando sea posible: usa public_media_search, public_web_extract_urls y public_media_download directamente desde el orquestador.",
      "Para imágenes prioriza Wikimedia Commons; para video/audio/material de Internet Archive prioriza archive.org. Dogpile queda como descubrimiento web general cuando no exista una fuente directa mejor.",
      "Si public_media_search devuelve direct_url y el usuario pidió el archivo, descárgalo con public_media_download y luego entrégalo con message_send; no lances browser_agent solo para abrir una URL directa.",
      "Usa browser_agent únicamente si la página exige JavaScript/interacción, login, CAPTCHA o si HTTP/API no permite obtener el recurso solicitado.",
    ],
  },
};
