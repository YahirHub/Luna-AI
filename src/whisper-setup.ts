import {
  DEFAULT_WHISPER_CONFIG,
  WHISPER_MODEL_CATALOG,
  deleteDownloadedWhisperModelsExcept,
  downloadWhisperModel,
  getWhisperConfigPath,
  getWhisperModel,
  isWhisperModelAvailable,
  loadWhisperConfig,
  saveWhisperConfig,
  type WhisperConfig,
  type WhisperDownloadProgress,
} from "./whisper-config.ts";

type WhisperSetupState =
  | { stage: "main" }
  | { stage: "models" }
  | { stage: "confirm-model"; modelId: string }
  | { stage: "language" }
  | { stage: "custom-language" }
  | { stage: "threads" }
  | { stage: "best-of" }
  | { stage: "beam-size" }
  | { stage: "temperature" }
  | { stage: "no-speech" }
  | { stage: "max-audio" }
  | { stage: "timeout" }
  | { stage: "cleanup" };

export interface WhisperSetupResult {
  text: string;
  done: boolean;
}

export type WhisperSetupProgressHandler = (
  progress: WhisperDownloadProgress,
) => void | Promise<void>;

function yes(value: string): boolean {
  return ["si", "sí", "s", "yes", "y"].includes(value.trim().toLowerCase());
}

function no(value: string): boolean {
  return ["no", "n"].includes(value.trim().toLowerCase());
}

export class WhisperSetupManager {
  private states = new Map<string, WhisperSetupState>();

  constructor(
    private readonly configPath = getWhisperConfigPath(),
    private readonly downloader = downloadWhisperModel,
    private readonly availability = isWhisperModelAvailable,
    private readonly cleanup = deleteDownloadedWhisperModelsExcept,
  ) {}

  private modelStatus(modelId: string): string {
    if (this.availability(modelId)) {
      return modelId === DEFAULT_WHISPER_CONFIG.modelId ? "INCLUIDO/LISTO" : "DESCARGADO";
    }
    return "NO DESCARGADO";
  }

  has(jid: string): boolean {
    return this.states.has(jid);
  }

  start(jid: string): string {
    this.states.set(jid, { stage: "main" });
    return this.renderMainMenu(loadWhisperConfig(this.configPath));
  }

  cancel(jid: string): void {
    this.states.delete(jid);
  }

  private renderMainMenu(config: WhisperConfig): string {
    const currentModel = getWhisperModel(config.modelId);
    return [
      "🎙️ CONFIGURACIÓN GLOBAL DE WHISPER",
      "",
      `Modelo: ${config.modelId} · ${currentModel?.displaySize ?? "tamaño desconocido"}`,
      `Estado: ${this.modelStatus(config.modelId)}`,
      `Idioma: ${config.language}`,
      `Traducir al inglés: ${config.translateToEnglish ? "SÍ" : "NO"}`,
      `Hilos: ${config.threads === 0 ? "AUTOMÁTICO" : config.threads}`,
      `Best-of: ${config.bestOf}`,
      `Beam size: ${config.beamSize}`,
      `Temperatura: ${config.temperature}`,
      `Umbral sin voz: ${config.noSpeechThreshold}`,
      `Duración máxima: ${config.maxAudioSeconds} segundos`,
      `Timeout: ${config.timeoutSeconds} segundos`,
      "",
      "1. Seleccionar o descargar modelo",
      "2. Cambiar idioma",
      "3. Activar/desactivar traducción al inglés",
      "4. Cambiar hilos",
      "5. Cambiar best-of",
      "6. Cambiar beam size",
      "7. Cambiar temperatura",
      "8. Cambiar umbral sin voz",
      "9. Cambiar duración máxima",
      "10. Cambiar timeout",
      "11. Eliminar modelos descargados que no estén activos",
      "0. Guardar y salir",
      "",
      "Los cambios son globales y se aplican al siguiente audio.",
      "Usa /cancelar para cerrar el flujo.",
    ].join("\n");
  }

  private renderModels(): string {
    const lines = WHISPER_MODEL_CATALOG.map((entry, index) => {
      const language = entry.multilingual ? "multi" : "solo inglés";
      const notes = entry.notes ? ` · ${entry.notes}` : "";
      return `${index + 1}. ${entry.id} — ${entry.displaySize} · ${language} · ${this.modelStatus(entry.id)}${notes}`;
    });
    return [
      "📦 MODELOS OFICIALES DE WHISPER.CPP",
      "",
      ...lines,
      "",
      "Envía el número del modelo. Los tamaños son aproximados.",
      "Envía 0 para volver.",
    ].join("\n");
  }

  async submit(
    jid: string,
    input: string,
    onProgress?: WhisperSetupProgressHandler,
  ): Promise<WhisperSetupResult> {
    const state = this.states.get(jid);
    if (!state) throw new Error("No existe una configuración de Whisper activa.");
    const value = input.trim();
    const normalized = value.toLowerCase();
    const current = loadWhisperConfig(this.configPath);

    if (state.stage === "main") {
      if (["0", "salir", "listo"].includes(normalized)) {
        this.cancel(jid);
        return { done: true, text: "✅ Configuración global de Whisper guardada." };
      }
      const nextStages: Record<string, WhisperSetupState> = {
        "1": { stage: "models" },
        "2": { stage: "language" },
        "4": { stage: "threads" },
        "5": { stage: "best-of" },
        "6": { stage: "beam-size" },
        "7": { stage: "temperature" },
        "8": { stage: "no-speech" },
        "9": { stage: "max-audio" },
        "10": { stage: "timeout" },
        "11": { stage: "cleanup" },
      };
      if (normalized === "3") {
        const saved = saveWhisperConfig({ ...current, translateToEnglish: !current.translateToEnglish }, this.configPath);
        return { done: false, text: `✅ Traducción actualizada.\n\n${this.renderMainMenu(saved)}` };
      }
      const next = nextStages[normalized];
      if (!next) return { done: false, text: `❌ Opción inválida.\n\n${this.renderMainMenu(current)}` };
      this.states.set(jid, next);
      switch (next.stage) {
        case "models": return { done: false, text: this.renderModels() };
        case "language": return {
          done: false,
          text: [
            "🌐 IDIOMA DE TRANSCRIPCIÓN",
            "",
            "1. Español (es)",
            "2. Detección automática (auto)",
            "3. Inglés (en)",
            "4. Otro código de idioma",
            "0. Volver",
          ].join("\n"),
        };
        case "threads": return { done: false, text: "🧵 Envía 0 para automático o un número de 1 a 32." };
        case "best-of": return { done: false, text: "🎯 Envía un valor best-of de 1 a 10. Más alto puede mejorar precisión y consumir más CPU." };
        case "beam-size": return { done: false, text: "🔀 Envía un beam size de 1 a 10. El valor recomendado es 5." };
        case "temperature": return { done: false, text: "🌡️ Envía una temperatura entre 0 y 1. Para transcripción estable usa 0." };
        case "no-speech": return { done: false, text: "🔇 Envía un umbral sin voz entre 0 y 1. El valor recomendado es 0.6." };
        case "max-audio": return { done: false, text: "⏱️ Envía la duración máxima permitida entre 30 y 600 segundos." };
        case "timeout": return { done: false, text: "⌛ Envía el timeout entre 60 y 3600 segundos." };
        case "cleanup": return {
          done: false,
          text: "🗑️ ¿Eliminar todos los modelos descargados excepto el activo? Responde SI o NO.",
        };
        default: return { done: false, text: this.renderMainMenu(current) };
      }
    }

    if (state.stage === "models") {
      if (normalized === "0") {
        this.states.set(jid, { stage: "main" });
        return { done: false, text: this.renderMainMenu(current) };
      }
      const index = Number.parseInt(value, 10) - 1;
      const selected = WHISPER_MODEL_CATALOG[index];
      if (!selected) return { done: false, text: `❌ Modelo inválido.\n\n${this.renderModels()}` };
      if (this.availability(selected.id)) {
        const saved = saveWhisperConfig({
          ...current,
          modelId: selected.id,
          language: selected.multilingual ? current.language : "en",
        }, this.configPath);
        this.states.set(jid, { stage: "main" });
        return { done: false, text: `✅ Modelo global activado: ${selected.id}.\n\n${this.renderMainMenu(saved)}` };
      }
      this.states.set(jid, { stage: "confirm-model", modelId: selected.id });
      return {
        done: false,
        text: [
          `⬇️ DESCARGAR ${selected.id}`,
          "",
          `Tamaño aproximado: ${selected.displaySize}`,
          selected.multilingual ? "Idiomas: multilingüe" : "Idiomas: solo inglés",
          "Se guardará en persistent/whisper/models y sobrevivirá reinicios de Docker.",
          "",
          "Responde SI para descargarlo o NO para volver.",
        ].join("\n"),
      };
    }

    if (state.stage === "confirm-model") {
      if (no(normalized)) {
        this.states.set(jid, { stage: "models" });
        return { done: false, text: this.renderModels() };
      }
      if (!yes(normalized)) {
        return { done: false, text: "❌ Responde SI para descargar o NO para volver." };
      }
      const selected = getWhisperModel(state.modelId);
      if (!selected) throw new Error("El modelo seleccionado ya no existe en el catálogo.");
      await this.downloader(selected.id, onProgress);
      const saved = saveWhisperConfig({
        ...current,
        modelId: selected.id,
        language: selected.multilingual ? current.language : "en",
      }, this.configPath);
      this.states.set(jid, { stage: "main" });
      return {
        done: false,
        text: `✅ Modelo descargado y activado globalmente: ${selected.id}.\n\n${this.renderMainMenu(saved)}`,
      };
    }

    if (state.stage === "language") {
      if (normalized === "0") {
        this.states.set(jid, { stage: "main" });
        return { done: false, text: this.renderMainMenu(current) };
      }
      const languages: Record<string, string> = { "1": "es", "2": "auto", "3": "en" };
      if (normalized === "4") {
        this.states.set(jid, { stage: "custom-language" });
        return { done: false, text: "Envía el código ISO del idioma, por ejemplo: fr, de, pt, ja." };
      }
      const language = languages[normalized];
      if (!language) return { done: false, text: "❌ Opción inválida. Envía 1, 2, 3, 4 o 0." };
      const selected = getWhisperModel(current.modelId);
      if (selected && !selected.multilingual && language !== "en") {
        return { done: false, text: "❌ El modelo activo solo admite inglés. Selecciona un modelo multilingüe primero." };
      }
      const saved = saveWhisperConfig({ ...current, language }, this.configPath);
      this.states.set(jid, { stage: "main" });
      return { done: false, text: `✅ Idioma actualizado.\n\n${this.renderMainMenu(saved)}` };
    }

    if (state.stage === "custom-language") {
      if (!/^[a-z]{2,3}$/i.test(value)) return { done: false, text: "❌ Usa un código ISO de 2 o 3 letras." };
      const selected = getWhisperModel(current.modelId);
      if (selected && !selected.multilingual && value.toLowerCase() !== "en") {
        return { done: false, text: "❌ El modelo activo solo admite inglés." };
      }
      const saved = saveWhisperConfig({ ...current, language: value.toLowerCase() }, this.configPath);
      this.states.set(jid, { stage: "main" });
      return { done: false, text: `✅ Idioma actualizado.\n\n${this.renderMainMenu(saved)}` };
    }

    const number = Number(value);
    const numericStages: Record<string, { min: number; max: number; key: keyof WhisperConfig }> = {
      threads: { min: 0, max: 32, key: "threads" },
      "best-of": { min: 1, max: 10, key: "bestOf" },
      "beam-size": { min: 1, max: 10, key: "beamSize" },
      temperature: { min: 0, max: 1, key: "temperature" },
      "no-speech": { min: 0, max: 1, key: "noSpeechThreshold" },
      "max-audio": { min: 30, max: 600, key: "maxAudioSeconds" },
      timeout: { min: 60, max: 3600, key: "timeoutSeconds" },
    };
    const numeric = numericStages[state.stage];
    if (numeric) {
      if (!Number.isFinite(number) || number < numeric.min || number > numeric.max) {
        return { done: false, text: `❌ Envía un valor entre ${numeric.min} y ${numeric.max}.` };
      }
      const saved = saveWhisperConfig({ ...current, [numeric.key]: number } as WhisperConfig, this.configPath);
      this.states.set(jid, { stage: "main" });
      return { done: false, text: `✅ Parámetro actualizado.\n\n${this.renderMainMenu(saved)}` };
    }

    if (state.stage === "cleanup") {
      if (no(normalized)) {
        this.states.set(jid, { stage: "main" });
        return { done: false, text: this.renderMainMenu(current) };
      }
      if (!yes(normalized)) return { done: false, text: "❌ Responde SI o NO." };
      const deleted = this.cleanup(current.modelId);
      this.states.set(jid, { stage: "main" });
      return {
        done: false,
        text: `✅ Se eliminaron ${deleted} modelo(s) descargado(s) que no estaban activos.\n\n${this.renderMainMenu(current)}`,
      };
    }

    throw new Error("Estado de configuración Whisper no reconocido.");
  }
}
