import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { ManualPiperModelCatalog, type ManualPiperModel } from "./manual-model-catalog.ts";
import { tmpdir } from "node:os";
import { getAppDir } from "../utils.ts";
import { sanitizePathSegment } from "../storage.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import { loadFfmpegRuntime } from "../media-processing/ffmpeg-native.ts";
import { PiperNeoRuntimeManager } from "./piper-neo-runtime.ts";
import { PiperVoiceCatalog, type PiperVoiceDefinition } from "./voice-catalog.ts";
import { loadUserTtsConfig, saveUserTtsConfig, type TtsResponseMode, type TtsVoiceSelection, type UserTtsConfig } from "./tts-config.ts";
import { detectTtsPersistentModeIntent, detectTtsTurnPreference, isTranscribedAudioMessage, sanitizeTextForSpeech } from "./text-sanitizer.ts";

export interface TtsAudioResult {
  audio: Buffer;
  mimetype: string;
  ptt: boolean;
  voice: string;
  text: string;
}

function normalizeQuery(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}



function qualityScore(voice: PiperVoiceDefinition): number {
  return voice.quality === "high" ? 4 : voice.quality === "medium" ? 3 : voice.quality === "low" ? 2 : 1;
}

function looksSpanish(text: string): boolean {
  return /[áéíóúñ¿¡]/i.test(text) || /\b(?:que|para|como|con|una|por|esto|esta|quiero|puede|puedes|gracias|tambien|también)\b/i.test(text);
}

export class TtsManager {
  readonly catalog: PiperVoiceCatalog;
  readonly runtime: PiperNeoRuntimeManager;
  readonly manualModels: ManualPiperModelCatalog;
  private readonly activeVoiceDownloads = new Map<string, AbortController>();
  constructor(
    readonly workspace: WorkspaceManager,
    readonly appDir = getAppDir(),
    catalog = new PiperVoiceCatalog(join(appDir, "persistent", "piper")),
    runtime = new PiperNeoRuntimeManager(),
  ) {
    this.catalog = catalog;
    this.runtime = runtime;
    const globalModelsDir = join(appDir, "persistent", "piper", "models");
    mkdirSync(globalModelsDir, { recursive: true });
    mkdirSync(join(globalModelsDir, "manual"), { recursive: true });
    this.manualModels = new ManualPiperModelCatalog(globalModelsDir);
  }

  getConfig(jid: string): UserTtsConfig { return loadUserTtsConfig(jid, this.appDir); }
  setResponseMode(jid: string, responseMode: TtsResponseMode): UserTtsConfig { return saveUserTtsConfig(jid, { responseMode }, this.appDir); }
  /** Compatibilidad con la interfaz anterior: on=solo voz, off=solo texto. */
  setEnabled(jid: string, enabled: boolean): UserTtsConfig { return this.setResponseMode(jid, enabled ? "voice" : "text"); }

  hasActiveVoiceDownload(jid: string): boolean {
    const controller = this.activeVoiceDownloads.get(jid);
    return Boolean(controller && !controller.signal.aborted);
  }

  cancelActiveVoiceDownload(jid: string): boolean {
    const controller = this.activeVoiceDownloads.get(jid);
    if (!controller || controller.signal.aborted) return false;
    controller.abort(new Error("Descarga de voz cancelada por el usuario."));
    return true;
  }

  private async downloadOfficialForUser(
    jid: string,
    voice: PiperVoiceDefinition,
    onProgress?: (message: string) => void | Promise<void>,
    externalSignal?: AbortSignal,
  ) {
    const existing = this.activeVoiceDownloads.get(jid);
    if (existing && !existing.signal.aborted) throw new Error("Ya hay una descarga de voz Piper activa para este usuario. Puedes cancelarla con !cancelar.");
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(externalSignal?.reason ?? new Error("Operación cancelada."));
    externalSignal?.addEventListener("abort", forwardAbort, { once: true });
    this.activeVoiceDownloads.set(jid, controller);
    try {
      return await this.catalog.download(voice.key, onProgress, controller.signal);
    } finally {
      externalSignal?.removeEventListener("abort", forwardAbort);
      if (this.activeVoiceDownloads.get(jid) === controller) this.activeVoiceDownloads.delete(jid);
    }
  }


  applyPersistentPreferenceFromMessage(jid: string, message: string): TtsResponseMode | null {
    const intent = detectTtsPersistentModeIntent(message);
    if (!intent) return null;
    this.setResponseMode(jid, intent);
    return intent;
  }

  shouldBlockVoiceTool(jid: string, message: string): boolean {
    const explicit = detectTtsTurnPreference(message);
    if (explicit === "text") return true;
    if (explicit === "voice") return false;
    return this.getConfig(jid).responseMode === "text";
  }

  canMutateResponseModeFromTool(message: string, target: TtsResponseMode): boolean {
    const persistent = detectTtsPersistentModeIntent(message);
    return persistent !== null && persistent === target;
  }

  buildTurnGuidance(jid: string, message: string): string {
    const config = this.getConfig(jid);
    const explicit = detectTtsTurnPreference(message);
    const audioInput = isTranscribedAudioMessage(message);
    return [
      `Modo de respuesta TTS: ${config.responseMode}.`,
      `Entrada actual: ${audioInput ? "audio transcrito" : "texto/otro medio"}.`,
      `Preferencia explícita detectada para este turno: ${explicit ?? "ninguna"}.`,
      "Prioridad: una petición explícita de texto o voz manda sobre cualquier heurística.",
      config.responseMode === "voice"
        ? "Modo solo voz: usa tts_speak para la respuesta final salvo que el usuario pida explícitamente texto en este turno."
        : config.responseMode === "text"
          ? "Modo solo texto: responde normalmente por texto salvo que el usuario pida explícitamente audio en este turno."
          : audioInput
            ? "Modo adaptativo y entrada de audio: puedes preferir tts_speak si una respuesta hablada resulta natural; no es obligatorio si el contenido requiere texto/código/listas."
            : "Modo adaptativo: elige texto o tts_speak según la intención y el tipo de contenido. No mandes ambos salvo que el usuario lo pida.",
    ].join("\n");
  }

  shouldForceVoice(jid: string, message: string): boolean {
    const explicit = detectTtsTurnPreference(message);
    if (explicit === "text") return false;
    if (explicit === "voice") return true;
    return this.getConfig(jid).responseMode === "voice";
  }

  /** Para resultados diferidos, un modo texto actual puede detener audios antiguos. */
  shouldForceDeferredVoice(jid: string, originMessage: string): boolean {
    const explicit = detectTtsTurnPreference(originMessage);
    if (explicit === "text") return false;
    const mode = this.getConfig(jid).responseMode;
    if (mode === "text") return false;
    if (mode === "voice") return true;
    return explicit === "voice";
  }

  formatStatus(jid: string): string {
    const config = this.getConfig(jid);
    const selected = config.selectedVoice
      ? config.selectedVoice.kind === "official"
        ? config.selectedVoice.id
        : config.selectedVoice.kind === "manual"
          ? `${config.selectedVoice.id} (${config.selectedVoice.format} manual)`
          : `${config.selectedVoice.id} (.neo privado)`
      : "ninguna";
    return [
      "🔊 PIPER NEO",
      `Modo de respuesta: ${config.responseMode === "adaptive" ? "adaptativo (el modelo decide)" : config.responseMode === "voice" ? "solo voz" : "solo texto"}`,
      `Voz seleccionada: ${selected}`,
      `Modo WhatsApp: ${config.ptt ? "nota de voz (Opus)" : "audio"}`,
      `Runtime: ${this.runtime.description()}`,
    ].join("\n");
  }

  formatLanguages(): string {
    const languages = this.catalog.listLanguages();
    return [
      `🌐 IDIOMAS DE PIPER (${languages.length})`,
      ...languages.map((language) => `- ${language.code}: ${language.native} / ${language.english} (${language.country}) · ${language.voices} voz/ces`),
    ].join("\n");
  }

  formatVoices(language?: string, limit = 40): string {
    const voices = this.catalog.listByLanguage(language);
    if (!voices.length) return `No encontré voces para "${language ?? "ese idioma"}".`;
    const shown = voices.slice(0, Math.max(1, Math.min(100, limit)));
    return [
      `🗣️ VOCES${language ? ` · ${language}` : ""} (${voices.length})`,
      ...shown.map((voice) => {
        const downloaded = this.catalog.isDownloaded(voice) ? " · descargada" : "";
        const speakers = voice.num_speakers > 1 ? ` · ${voice.num_speakers} speakers` : "";
        return `- ${voice.key} — ${voice.language.name_native} (${voice.language.country_english}) · ${voice.quality}${speakers}${downloaded}`;
      }),
      ...(voices.length > shown.length ? [`… ${voices.length - shown.length} voz/ces más. Filtra por locale o nombre.`] : []),
    ].join("\n");
  }


  listManualModels(): ManualPiperModel[] {
    return this.manualModels.list();
  }

  formatManualModels(): string {
    const { models, invalid } = this.manualModels.scan();
    if (!models.length && !invalid.length) {
      return [
        "📁 No hay modelos manuales globales en persistent/piper/models/.",
        "Puedes colocar .neo directamente o pares .onnx + .onnx.json dentro de cualquier subcarpeta (excepto official/).",
      ].join("\n");
    }
    return [
      `📁 MODELOS PIPER MANUALES GLOBALES (${models.length})`,
      ...models.map((model) => `- ${model.id} · ${model.kind.toUpperCase()} · ${model.relativePath}`),
      ...(invalid.length ? ["", "⚠️ IGNORADOS", ...invalid.map((item) => `- ${item.relativePath}: ${item.reason}`)] : []),
    ].join("\n");
  }

  selectManual(jid: string, query: string): TtsVoiceSelection {
    const resolved = this.manualModels.resolve(query);
    if (resolved.ambiguous?.length) {
      throw new Error(`El modelo manual es ambiguo. Coincidencias: ${resolved.ambiguous.slice(0, 10).map((item) => item.id).join(", ")}`);
    }
    const model = resolved.model;
    if (!model) throw new Error(`No encontré el modelo manual "${query}" en persistent/piper/models/.`);
    const selection: TtsVoiceSelection = {
      kind: "manual",
      id: model.id,
      path: model.modelPath,
      configPath: model.configPath,
      format: model.kind,
    };
    saveUserTtsConfig(jid, { selectedVoice: selection }, this.appDir);
    return selection;
  }

  private customDir(jid: string): string {
    const dir = join(this.appDir, "persistent", "contexts", sanitizePathSegment(jid), "tts", "models");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  listCustom(jid: string): string[] {
    const dir = this.customDir(jid);
    return readdirSync(dir).filter((name: string) => name.toLowerCase().endsWith(".neo")).sort();
  }

  formatCustomModels(jid: string): string {
    const models = this.listCustom(jid);
    const selected = this.getConfig(jid).selectedVoice;
    if (!models.length) return "📦 No hay modelos .neo importados para este usuario.";
    return [
      "📦 MODELOS .NEO IMPORTADOS",
      ...models.map((name) => {
        const id = basename(name, ".neo");
        const active = selected?.kind === "neo" && selected.id === id ? " · activo" : "";
        return `- ${id}${active}`;
      }),
    ].join("\n");
  }

  selectCustom(jid: string, id: string): TtsVoiceSelection {
    const normalized = sanitizePathSegment(id.trim().replace(/\.neo$/i, ""));
    if (!normalized) throw new Error("Indica el nombre del modelo .neo.");
    const path = join(this.customDir(jid), `${normalized}.neo`);
    if (!existsSync(path)) throw new Error(`No existe el modelo .neo ${normalized}.`);
    const selection: TtsVoiceSelection = { kind: "neo", id: normalized, path };
    saveUserTtsConfig(jid, { selectedVoice: selection }, this.appDir);
    return selection;
  }

  importNeo(jid: string, workspacePath: string, name?: string): TtsVoiceSelection {
    const source = this.workspace.resolvePath(jid, workspacePath, { mustExist: true });
    if (extname(source).toLowerCase() !== ".neo") throw new Error("El archivo debe tener extensión .neo.");
    const filename = `${sanitizePathSegment(name?.trim() || basename(source, extname(source)))}.neo`;
    const destination = join(this.customDir(jid), filename);
    copyFileSync(source, destination);
    const selection: TtsVoiceSelection = { kind: "neo", id: basename(filename, ".neo"), path: destination };
    saveUserTtsConfig(jid, { selectedVoice: selection }, this.appDir);
    return selection;
  }

  private defaultVoice(text: string): PiperVoiceDefinition {
    const locale = looksSpanish(text) ? "es_MX" : "en_US";
    const voices = this.catalog.listByLanguage(locale).sort((a, b) => qualityScore(b) - qualityScore(a) || a.key.localeCompare(b.key));
    const fallback = this.catalog.list().sort((a, b) => qualityScore(b) - qualityScore(a))[0];
    const selected = voices[0] ?? fallback;
    if (!selected) throw new Error("El catálogo no contiene voces.");
    return selected;
  }

  async selectOfficial(
    jid: string,
    query: string,
    language?: string,
    onProgress?: (message: string) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<PiperVoiceDefinition> {
    const voice = this.catalog.resolve(query, language);
    if (!voice) {
      const matches = this.catalog.listByLanguage(language).filter((item) => normalizeQuery(item.key).includes(normalizeQuery(query))).slice(0, 8);
      throw new Error(matches.length ? `La voz es ambigua. Coincidencias: ${matches.map((item) => item.key).join(", ")}` : `No encontré la voz "${query}".`);
    }
    await this.downloadOfficialForUser(jid, voice, onProgress, signal);
    saveUserTtsConfig(jid, { selectedVoice: { kind: "official", id: voice.key } }, this.appDir);
    return voice;
  }

  async ensureSelection(
    jid: string,
    text: string,
    options: { signal?: AbortSignal; onProgress?: (message: string) => void | Promise<void> } = {},
  ): Promise<{ selection: TtsVoiceSelection; modelPath: string; configPath?: string; voiceId: string }> {
    let config = this.getConfig(jid);
    let selection = config.selectedVoice;
    if (!selection) {
      const voice = this.defaultVoice(text);
      await this.downloadOfficialForUser(jid, voice, options.onProgress, options.signal);
      selection = { kind: "official", id: voice.key };
      config = saveUserTtsConfig(jid, { selectedVoice: selection }, this.appDir);
    }
    if (selection.kind === "neo") {
      if (!existsSync(selection.path)) throw new Error(`El modelo .neo seleccionado ya no existe: ${selection.path}`);
      return { selection, modelPath: selection.path, voiceId: selection.id };
    }
    if (selection.kind === "manual") {
      const resolved = this.manualModels.resolve(selection.id).model;
      if (!resolved || !existsSync(resolved.modelPath)) {
        throw new Error(`El modelo manual seleccionado ya no existe o dejó de ser válido: ${selection.id}. Revisa persistent/piper/models/.`);
      }
      return {
        selection: { kind: "manual", id: resolved.id, path: resolved.modelPath, configPath: resolved.configPath, format: resolved.kind },
        modelPath: resolved.modelPath,
        configPath: resolved.configPath,
        voiceId: resolved.id,
      };
    }
    const voice = this.catalog.get(selection.id);
    if (!voice) throw new Error(`La voz seleccionada ya no existe en el catálogo: ${selection.id}`);
    const paths = this.catalog.isDownloaded(voice)
      ? this.catalog.pathsFor(voice)
      : await this.downloadOfficialForUser(jid, voice, options.onProgress, options.signal);
    return { selection, modelPath: paths.modelPath, configPath: paths.configPath, voiceId: voice.key };
  }

  private async wavToOpus(wav: Buffer): Promise<Buffer> {
    const runtime = loadFfmpegRuntime();
    const dir = join(tmpdir(), `luna-tts-${crypto.randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const input = join(dir, "speech.wav");
    const output = join(dir, "speech.ogg");
    writeFileSync(input, wav);
    try {
      const child = Bun.spawn([
        runtime.executable,
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", input,
        "-vn", "-c:a", "libopus", "-b:a", "32k", "-vbr", "on", "-application", "voip",
        "-f", "ogg", output,
      ], { cwd: dir, stdout: "pipe", stderr: "pipe", windowsHide: true });
      const stderr = child.stderr ? new Response(child.stderr).text() : Promise.resolve("");
      const stdout = child.stdout ? new Response(child.stdout).text() : Promise.resolve("");
      const code = await child.exited;
      const [out, err] = await Promise.all([stdout, stderr]);
      if (code !== 0 || !existsSync(output)) throw new Error((err || out || `código ${code}`).trim().slice(-1200));
      return readFileSync(output);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  async synthesize(
    jid: string,
    rawText: string,
    options: { ptt?: boolean; signal?: AbortSignal; onProgress?: (message: string) => void | Promise<void> } = {},
  ): Promise<TtsAudioResult> {
    const text = sanitizeTextForSpeech(rawText);
    if (!text) throw new Error("No hay texto pronunciable después de limpiar el Markdown.");
    if (text.length > 12_000) throw new Error("La respuesta supera 12,000 caracteres. Resume el contenido antes de convertirlo a voz.");
    const config = this.getConfig(jid);
    const selected = await this.ensureSelection(jid, text, { signal: options.signal, onProgress: options.onProgress });
    const wav = await this.runtime.synthesize({
      text,
      modelPath: selected.modelPath,
      configPath: selected.configPath,
      voiceId: selected.voiceId,
      speakerId: config.speakerId,
      lengthScale: config.lengthScale,
      noiseScale: config.noiseScale,
      noiseWScale: config.noiseWScale,
      signal: options.signal,
    });
    const usePtt = options.ptt ?? config.ptt;
    if (usePtt) {
      try {
        const audio = await this.wavToOpus(wav);
        return { audio, mimetype: "audio/ogg; codecs=opus", ptt: true, voice: selected.voiceId, text };
      } catch {
        // WAV sigue siendo una salida válida si el encoder Opus no está disponible.
      }
    }
    return { audio: wav, mimetype: "audio/wav", ptt: false, voice: selected.voiceId, text };
  }
}
