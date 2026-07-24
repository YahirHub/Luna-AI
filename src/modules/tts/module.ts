import type { LunaModule } from "../types.ts";
import { isTranscribedAudioMessage } from "../../tts/text-sanitizer.ts";

export const TTS_MODULE: LunaModule = {
  id: "tts",
  name: "Piper Neo TTS",
  description: "Síntesis de voz local con Piper Neo, selección de voces por idioma y modelos globales .onnx/.neo",
  category: "media",
  access: "authenticated",
  scope: "hybrid",
  commands: [
    { name: "voz", description: "Gestiona Piper Neo: estado, activar/desactivar, seleccionar/importar y probar voz" },
    { name: "voces", description: "Lista las voces disponibles, opcionalmente filtradas por idioma" },
  ],
  tools: [
    // Hablar/consultar estado es la ruta frecuente; configuración avanzada se difiere.
    { name: "tts_status" },
    { name: "tts_set_mode" },
    { name: "tts_set_enabled" },
    { name: "tts_speak" },
    { name: "tts_list_voices", defer: true },
    { name: "tts_select_voice", defer: true },
    { name: "tts_list_manual_models", defer: true },
    { name: "tts_select_manual_model", defer: true },
    { name: "tts_list_custom_models", defer: true },
    { name: "tts_select_custom_model", defer: true },
    { name: "tts_import_neo", defer: true },
  ],
  prompt: {
    summary: "Convierte respuestas a audio local con Piper Neo, administra voces oficiales y descubre modelos globales .onnx/.neo colocados manualmente.",
    keywords: ["voz", "audio", "tts", "piper", "habla", "pronuncia", "escuchar", "modelo neo", ".neo", ".onnx", "modelo manual"],
    patterns: [/\b(?:mand|envi|respond).{0,30}(?:audio|voz)\b/iu, /\b(?:voces?|tts|piper)\b/iu],
    activateWhen: (message) => isTranscribedAudioMessage(message),
    instructions: [
      "Respeta primero cualquier petición explícita de texto o voz y la política [tts]. La preferencia es autoritativa en runtime: si el turno exige texto, tts_speak será bloqueada aunque intentes usarla. En modo adaptativo, audio conversacional favorece voz; código/tablas/comandos favorecen texto.",
      "Si respondes solo con voz usa tts_speak como última acción; tts_set_mode solo cambia preferencias persistentes cuando el usuario lo pide explícitamente.",
      "Para administrar voces/modelos o importar .neo carga completamente tts con capability_load en vez de recibir ese catálogo en todos los turnos.",
    ],
    loadInstructions: [
      "Para elegir voz usa tts_list_voices y luego tts_select_voice; no inventes IDs. Las voces oficiales se descargan solo cuando hacen falta.",
      "Los modelos manuales globales se descubren bajo persistent/piper/models; usa tts_list_manual_models/tts_select_manual_model. Los .neo importados desde workdir permanecen privados por usuario.",
      "tts_speak sanea Markdown, código, URLs, emojis y decoración antes de sintetizar.",
    ],
  },
};
