import type { LunaModule } from "../types.ts";
export const ARTIFACTS_MODULE: LunaModule = {
  id: "artifacts", name: "Artefactos", description: "PDF, ZIP y envío de archivos", category: "files",
  access: "authenticated", scope: "user",
  tools: [{ name: "create_pdf_from_markdown" }, { name: "archive_folder" }, { name: "gitzip" }, { name: "message_send" }],
  prompt: { summary: "Genera PDF/ZIP y entrega artefactos físicos por el transporte activo.", keywords: ["pdf", "zip", "comprimido", "archivo", "envia", "envía", "captura"], instructions: [
    "Cuando el usuario pida un archivo, crea primero el contenido físico y después envíalo con message_send.",
    "Para Markdown usa sintaxis Markdown válida aunque las respuestas normales de WhatsApp usen texto simple.",
  ] },
};
