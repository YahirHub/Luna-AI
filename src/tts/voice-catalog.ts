import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { getAppDir } from "../utils.ts";
import { debugInfo, debugWarn } from "../debug.ts";

export interface PiperVoiceLanguage {
  code: string;
  family: string;
  region: string;
  name_native: string;
  name_english: string;
  country_english: string;
}

export interface PiperVoiceFile {
  size_bytes: number;
  md5_digest: string;
}

export interface PiperVoiceDefinition {
  key: string;
  name: string;
  language: PiperVoiceLanguage;
  quality: string;
  num_speakers: number;
  speaker_id_map: Record<string, number>;
  files: Record<string, PiperVoiceFile>;
  aliases: string[];
}

export interface DownloadedVoicePaths {
  voice: PiperVoiceDefinition;
  modelPath: string;
  configPath: string;
}

const HUGGINGFACE_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main";

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findBundledCatalogPath(): string {
  const roots = [
    join(getAppDir(), "runtime", "piper-neo", "voices.json"),
    join(getAppDir(), "assets", "piper", "voices.json"),
    join(process.cwd(), "dist", "runtime", "piper-neo", "voices.json"),
    join(process.cwd(), "assets", "piper", "voices.json"),
  ];
  const found = roots.find((path) => existsSync(path));
  if (!found) throw new Error("No se encontró el catálogo de voces de Piper.");
  return found;
}

async function md5(path: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hasher = createHash("md5");
    const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
    stream.on("data", (chunk) => hasher.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hasher.digest("hex")));
  });
}

type ProgressCallback = (message: string) => void | Promise<void>;

const DOWNLOAD_STALL_TIMEOUT_MS = 45_000;
const DOWNLOAD_TOTAL_TIMEOUT_MS = 30 * 60_000;
const DOWNLOAD_MAX_ATTEMPTS = 3;
const PROGRESS_INTERVAL_MS = 15_000;
const PROGRESS_PERCENT_STEP = 10;

function formatMiB(bytes: number): string { return `${(bytes / 1024 / 1024).toFixed(1)} MiB`; }
function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "calculando velocidad";
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MiB/s`;
  return `${Math.max(1, Math.round(bytesPerSecond / 1024))} KiB/s`;
}

function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "Descarga cancelada.");
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError(signal.reason);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(abortError(signal?.reason)); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function validateDownloadedFile(path: string, expected: PiperVoiceFile): Promise<boolean> {
  if (!existsSync(path) || statSync(path).size !== expected.size_bytes) return false;
  return (await md5(path)) === expected.md5_digest.toLowerCase();
}

async function downloadFile(
  url: string,
  destination: string,
  expected: PiperVoiceFile,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<void> {
  if (await validateDownloadedFile(destination, expected)) return;
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.part`;
  if (existsSync(temporary) && statSync(temporary).size > expected.size_bytes) rmSync(temporary, { force: true });

  for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw abortError(signal.reason);
    let resumeFrom = existsSync(temporary) ? statSync(temporary).size : 0;
    if (resumeFrom === expected.size_bytes) {
      await onProgress?.(`Verificando ${basename(destination)} (${formatMiB(resumeFrom)})...`);
      if (await validateDownloadedFile(temporary, expected)) {
        rmSync(destination, { force: true });
        renameSync(temporary, destination);
        return;
      }
      rmSync(temporary, { force: true });
      resumeFrom = 0;
    }

    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason ?? new Error("Descarga cancelada por el usuario."));
    signal?.addEventListener("abort", forwardAbort, { once: true });
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const totalTimer = setTimeout(() => controller.abort(new Error("La descarga excedió 30 minutos.")), DOWNLOAD_TOTAL_TIMEOUT_MS);
    const resetStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => controller.abort(new Error("Hugging Face no entregó datos durante 45 segundos.")), DOWNLOAD_STALL_TIMEOUT_MS);
    };
    resetStallTimer();

    let fd: number | null = null;
    try {
      const headers: Record<string, string> = { "User-Agent": `Luna-AI-Piper-Voices/Bun-${Bun.version}` };
      if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;
      await onProgress?.(
        resumeFrom > 0
          ? `Reanudando ${basename(destination)} desde ${formatMiB(resumeFrom)} (${attempt}/${DOWNLOAD_MAX_ATTEMPTS})...`
          : `Conectando con Hugging Face para ${basename(destination)} (${attempt}/${DOWNLOAD_MAX_ATTEMPTS})...`,
      );
      debugInfo("tts.voice-download", "request_started", { file: basename(destination), attempt, resumeFrom, expectedBytes: expected.size_bytes });
      const response = await fetch(url, { signal: controller.signal, headers, redirect: "follow" });
      resetStallTimer();
      if (response.status === 416 && resumeFrom === expected.size_bytes) continue;
      if (!response.ok || !response.body) throw new Error(`Hugging Face respondió HTTP ${response.status}.`);

      // Si el CDN ignora Range y devuelve 200, reiniciamos el .part para no duplicar bytes.
      if (resumeFrom > 0 && response.status !== 206) {
        debugWarn("tts.voice-download", "range_ignored_restart", { file: basename(destination), status: response.status, resumeFrom });
        rmSync(temporary, { force: true });
        resumeFrom = 0;
      }

      fd = openSync(temporary, resumeFrom > 0 ? "a" : "w");
      const reader = response.body.getReader();
      let downloaded = resumeFrom;
      const startedAt = Date.now();
      let lastProgressAt = 0;
      let lastPercentBucket = Math.floor((downloaded / expected.size_bytes) * 100 / PROGRESS_PERCENT_STEP);

      while (true) {
        if (signal?.aborted) throw abortError(signal.reason);
        const { done, value } = await reader.read();
        if (done) break;
        resetStallTimer();
        if (!value?.byteLength) continue;
        writeSync(fd, value);
        downloaded += value.byteLength;
        if (downloaded > expected.size_bytes) throw new Error(`La descarga excedió el tamaño esperado (${downloaded} > ${expected.size_bytes} bytes).`);

        const now = Date.now();
        const percent = Math.min(100, (downloaded / expected.size_bytes) * 100);
        const bucket = Math.floor(percent / PROGRESS_PERCENT_STEP);
        if (bucket > lastPercentBucket || now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
          const elapsedSeconds = Math.max(0.001, (now - startedAt) / 1000);
          const rate = (downloaded - resumeFrom) / elapsedSeconds;
          await onProgress?.(`${basename(destination)}: ${percent.toFixed(0)}% · ${formatMiB(downloaded)} / ${formatMiB(expected.size_bytes)} · ${formatRate(rate)}`);
          debugInfo("tts.voice-download", "progress", { file: basename(destination), percent: Math.round(percent), downloaded, expectedBytes: expected.size_bytes, bytesPerSecond: Math.round(rate) });
          lastProgressAt = now;
          lastPercentBucket = bucket;
        }
      }

      closeSync(fd);
      fd = null;
      const size = statSync(temporary).size;
      if (size !== expected.size_bytes) throw new Error(`Descarga incompleta: ${size} bytes, esperados ${expected.size_bytes}.`);
      await onProgress?.(`Verificando integridad MD5 de ${basename(destination)}...`);
      const digest = await md5(temporary);
      if (digest !== expected.md5_digest.toLowerCase()) {
        rmSync(temporary, { force: true });
        throw new Error(`MD5 inválido: ${digest}. Se descartó la descarga corrupta.`);
      }
      rmSync(destination, { force: true });
      renameSync(temporary, destination);
      await onProgress?.(`${basename(destination)} completado · ${formatMiB(size)}.`);
      debugInfo("tts.voice-download", "completed", { file: basename(destination), bytes: size, attempt });
      return;
    } catch (error) {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* ya cerrado */ }
      }
      if (signal?.aborted) throw abortError(signal.reason);
      const message = error instanceof Error ? error.message : String(error);
      debugWarn("tts.voice-download", "attempt_failed", { file: basename(destination), attempt, error: message, partialBytes: existsSync(temporary) ? statSync(temporary).size : 0 });
      if (attempt >= DOWNLOAD_MAX_ATTEMPTS) throw new Error(`No se pudo descargar ${basename(destination)} después de ${DOWNLOAD_MAX_ATTEMPTS} intentos: ${message}`);
      await onProgress?.(`⚠️ Descarga interrumpida: ${message} Reintentando en ${attempt * 2}s...`);
      await sleep(attempt * 2_000, signal);
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
      clearTimeout(totalTimer);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }
}

export class PiperVoiceCatalog {
  private cache: PiperVoiceDefinition[] | null = null;
  constructor(
    readonly persistentRoot = join(getAppDir(), "persistent", "piper"),
    readonly catalogPath = findBundledCatalogPath(),
  ) {}

  list(): PiperVoiceDefinition[] {
    if (this.cache) return this.cache;
    const raw = JSON.parse(readFileSync(this.catalogPath, "utf8")) as Record<string, PiperVoiceDefinition>;
    this.cache = Object.values(raw).sort((a, b) => a.key.localeCompare(b.key));
    return this.cache;
  }

  listLanguages(): Array<{ code: string; family: string; native: string; english: string; country: string; voices: number }> {
    const map = new Map<string, { code: string; family: string; native: string; english: string; country: string; voices: number }>();
    for (const voice of this.list()) {
      const current = map.get(voice.language.code);
      if (current) current.voices += 1;
      else map.set(voice.language.code, {
        code: voice.language.code,
        family: voice.language.family,
        native: voice.language.name_native,
        english: voice.language.name_english,
        country: voice.language.country_english,
        voices: 1,
      });
    }
    return [...map.values()].sort((a, b) => a.english.localeCompare(b.english) || a.code.localeCompare(b.code));
  }

  listByLanguage(query?: string): PiperVoiceDefinition[] {
    if (!query?.trim()) return this.list();
    const q = normalize(query);
    return this.list().filter((voice) => {
      const language = voice.language;
      const candidates = [language.code, language.family, language.name_native, language.name_english, language.country_english];
      return candidates.some((value) => {
        const n = normalize(value);
        return n === q || n.startsWith(`${q} `) || q.startsWith(`${n} `);
      });
    });
  }

  resolve(query: string, language?: string): PiperVoiceDefinition | null {
    const q = normalize(query);
    const pool = language ? this.listByLanguage(language) : this.list();
    const exact = pool.find((voice) => normalize(voice.key) === q || voice.aliases.some((alias) => normalize(alias) === q));
    if (exact) return exact;
    const byName = pool.filter((voice) => normalize(voice.name) === q);
    if (byName.length === 1) return byName[0]!;
    const partial = pool.filter((voice) => normalize(voice.key).includes(q) || normalize(voice.name).includes(q));
    return partial.length === 1 ? partial[0]! : null;
  }

  get(key: string): PiperVoiceDefinition | null {
    return this.list().find((voice) => voice.key === key) ?? null;
  }

  voiceDir(key: string): string { return join(this.persistentRoot, "models", "official", key); }

  pathsFor(voice: PiperVoiceDefinition): DownloadedVoicePaths {
    const modelEntry = Object.entries(voice.files).find(([path]) => path.endsWith(".onnx"));
    const configEntry = Object.entries(voice.files).find(([path]) => path.endsWith(".onnx.json"));
    if (!modelEntry || !configEntry) throw new Error(`La voz ${voice.key} no contiene ONNX + JSON.`);
    const dir = this.voiceDir(voice.key);
    return {
      voice,
      modelPath: join(dir, basename(modelEntry[0])),
      configPath: join(dir, basename(configEntry[0])),
    };
  }

  isDownloaded(voice: PiperVoiceDefinition): boolean {
    const paths = this.pathsFor(voice);
    return existsSync(paths.modelPath) && existsSync(paths.configPath);
  }

  async download(key: string, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<DownloadedVoicePaths> {
    const voice = this.get(key);
    if (!voice) throw new Error(`Voz desconocida: ${key}`);
    const entries = Object.entries(voice.files).filter(([path]) => path.endsWith(".onnx") || path.endsWith(".onnx.json"));
    const paths = this.pathsFor(voice);
    mkdirSync(this.voiceDir(key), { recursive: true });
    for (const [index, [remotePath, metadata]] of entries.entries()) {
      const target = remotePath.endsWith(".onnx.json") ? paths.configPath : paths.modelPath;
      await onProgress?.(`Descargando ${voice.key} (${index + 1}/${entries.length}): ${basename(remotePath)} · ${formatMiB(metadata.size_bytes)}`);
      await downloadFile(`${HUGGINGFACE_BASE}/${remotePath.split("/").map(encodeURIComponent).join("/")}`, target, metadata, onProgress, signal);
    }
    return paths;
  }
}
