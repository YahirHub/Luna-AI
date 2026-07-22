import type { LunaModule } from "../types.ts";
export const WHISPER_MODULE: LunaModule = {
  id: "whisper", name: "Whisper", description: "Transcripción local y modelos Whisper", category: "media",
  access: "authenticated", scope: "global",
  commands: [{ name: "setup-whisper", description: "Configura modelo y parámetros globales de transcripción", access: "admin" }],
  tools: [
    { name: "whisper_status", access: "admin" }, { name: "whisper_list_models", access: "admin" }, { name: "whisper_update_config", access: "admin" },
    { name: "whisper_download_model", access: "admin" }, { name: "whisper_cleanup_models", access: "admin" },
  ],
  prompt: { summary: "Administra transcripción local Whisper; configuración disponible solo para administradores.", keywords: ["whisper", "transcripcion", "transcripción", "audio", "modelo whisper"], instructions: [
    "Antes de descargar un modelo informa su tamaño y hazlo solo ante petición/confirmación explícita del administrador.",
    "Las transcripciones automáticas pueden contener errores; ante ambigüedad importante pide una aclaración breve antes de ejecutar acciones persistentes.",
  ] },
};
