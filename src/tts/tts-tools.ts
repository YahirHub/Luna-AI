import type { ToolDefinition } from "../ai.ts";
import type { MessagingTransport } from "../transports/types.ts";
import type { TtsManager } from "./tts-manager.ts";

export const TTS_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "tts_status",
      description: "Consulta el estado de Piper Neo, la voz seleccionada y si las respuestas automáticas por voz están activadas.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "tts_list_voices",
      description: "Lista voces Piper filtradas por idioma, locale, nombre del idioma o país. Úsala antes de elegir una voz si el usuario no dio un ID exacto.",
      parameters: {
        type: "object",
        properties: {
          language: { type: "string", description: "Ejemplos: es, es_MX, Spanish, Español, Mexico." },
          limit: { type: "number", minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tts_select_voice",
      description: "Descarga si hace falta y selecciona una voz oficial de Piper para el usuario.",
      parameters: {
        type: "object",
        properties: {
          voice: { type: "string", description: "ID, alias o nombre de voz." },
          language: { type: "string", description: "Filtro opcional para resolver nombres ambiguos." },
        },
        required: ["voice"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tts_list_manual_models",
      description: "Lista modelos Piper globales colocados manualmente bajo persistent/piper/models, incluyendo .neo y pares .onnx + .onnx.json en subcarpetas.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "tts_select_manual_model",
      description: "Selecciona un modelo Piper global descubierto recursivamente en persistent/piper/models. Acepta el ID, nombre del archivo o nombre de carpeta cuando sea único.",
      parameters: {
        type: "object",
        properties: { model: { type: "string" } },
        required: ["model"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tts_list_custom_models",
      description: "Lista los modelos .neo privados que el usuario ya importó.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "tts_select_custom_model",
      description: "Selecciona un modelo .neo previamente importado por el usuario.",
      parameters: {
        type: "object",
        properties: { model: { type: "string" } },
        required: ["model"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tts_import_neo",
      description: "Importa un modelo Piper Neo .neo desde una ruta del workdir del usuario y lo selecciona.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Ruta relativa del archivo .neo en el workdir." },
          name: { type: "string", description: "Nombre opcional para guardar el modelo." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tts_set_mode",
      description: "Cambia la política persistente de respuesta: adaptive deja que el modelo elija por turno, voice fuerza voz salvo petición explícita de texto, y text fuerza texto salvo petición explícita de audio.",
      parameters: {
        type: "object",
        properties: { mode: { type: "string", enum: ["adaptive", "voice", "text"] } },
        required: ["mode"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tts_set_enabled",
      description: "Compatibilidad: true equivale a modo voice y false a modo text. Prefiere tts_set_mode para nuevas solicitudes.",
      parameters: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        required: ["enabled"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tts_speak",
      description: "Convierte un texto final a voz con Piper Neo y lo envía como audio/nota de voz. Úsala únicamente cuando el usuario pida escuchar la respuesta o recibir audio; debe ser la última acción del turno.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          ptt: { type: "boolean", description: "true para nota de voz WhatsApp; false para audio WAV." },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
];

export async function executeTtsTool(
  name: string,
  args: Record<string, unknown>,
  dependencies: {
    manager: TtsManager;
    transport: MessagingTransport;
    jid: string;
    signal?: AbortSignal;
    onProgress?: (text: string) => Promise<void>;
  },
): Promise<string> {
  try {
    if (name === "tts_status") return dependencies.manager.formatStatus(dependencies.jid);
    if (name === "tts_list_voices") {
      const language = typeof args.language === "string" ? args.language.trim() : undefined;
      const limit = typeof args.limit === "number" ? args.limit : 40;
      return dependencies.manager.formatVoices(language, limit);
    }
    if (name === "tts_select_voice") {
      const voice = typeof args.voice === "string" ? args.voice.trim() : "";
      const language = typeof args.language === "string" ? args.language.trim() : undefined;
      if (!voice) return "Error: voice es obligatorio.";
      const selected = await dependencies.manager.selectOfficial(dependencies.jid, voice, language, async (text) => {
        await dependencies.onProgress?.(`⬇️ Piper: ${text}`);
      }, dependencies.signal);
      return `✅ Voz Piper seleccionada: ${selected.key} (${selected.language.name_native}, ${selected.quality}).`;
    }
    if (name === "tts_list_manual_models") return dependencies.manager.formatManualModels();
    if (name === "tts_select_manual_model") {
      const model = typeof args.model === "string" ? args.model.trim() : "";
      if (!model) return "Error: model es obligatorio.";
      const selected = dependencies.manager.selectManual(dependencies.jid, model);
      return `✅ Modelo Piper manual seleccionado: ${selected.id}.`;
    }
    if (name === "tts_list_custom_models") return dependencies.manager.formatCustomModels(dependencies.jid);
    if (name === "tts_select_custom_model") {
      const model = typeof args.model === "string" ? args.model.trim() : "";
      if (!model) return "Error: model es obligatorio.";
      const selected = dependencies.manager.selectCustom(dependencies.jid, model);
      return `✅ Modelo Piper Neo seleccionado: ${selected.id}.`;
    }
    if (name === "tts_import_neo") {
      const path = typeof args.path === "string" ? args.path.trim() : "";
      if (!path) return "Error: path es obligatorio.";
      const selection = dependencies.manager.importNeo(dependencies.jid, path, typeof args.name === "string" ? args.name : undefined);
      return `✅ Modelo Piper Neo importado y seleccionado: ${selection.id}.`;
    }
    if (name === "tts_set_mode") {
      const mode = args.mode;
      if (mode !== "adaptive" && mode !== "voice" && mode !== "text") return "Error: mode debe ser adaptive, voice o text.";
      const config = dependencies.manager.setResponseMode(dependencies.jid, mode);
      return `✅ Modo de respuesta Piper Neo: ${config.responseMode}.`;
    }
    if (name === "tts_set_enabled") {
      if (typeof args.enabled !== "boolean") return "Error: enabled es obligatorio.";
      const config = dependencies.manager.setEnabled(dependencies.jid, args.enabled);
      return `✅ Modo de respuesta Piper Neo: ${config.responseMode}.`;
    }
    if (name === "tts_speak") {
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!text) return "Error: text es obligatorio.";
      const result = await dependencies.manager.synthesize(dependencies.jid, text, {
        ptt: typeof args.ptt === "boolean" ? args.ptt : undefined,
        signal: dependencies.signal,
        onProgress: async (progress) => dependencies.onProgress?.(`⬇️ Piper: ${progress}`),
      });
      const delivery = await dependencies.transport.send(dependencies.jid, { audio: result.audio, mimetype: result.mimetype, ptt: result.ptt }, { waitForDelivery: false });
      return JSON.stringify({ tts_sent: true, voice: result.voice, delivery, ptt: result.ptt, spoken_text: result.text });
    }
    return `Error: herramienta TTS desconocida: ${name}`;
  } catch (error) { return `Error: ${error instanceof Error ? error.message : String(error)}`; }
}
