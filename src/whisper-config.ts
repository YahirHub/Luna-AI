import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAppDir } from "./utils.ts";
import { readJsonFile, writeJsonFileAtomically } from "./storage.ts";

export type WhisperModelDefinition = {
  id: string;
  filename: string;
  displaySize: string;
  sizeBytes: number;
  multilingual: boolean;
  quantized: boolean;
  notes?: string;
};

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

type ByteStreamReadResult = {
  done: boolean;
  value?: Uint8Array;
};

type ByteStreamReader = {
  read(): Promise<ByteStreamReadResult>;
  cancel(reason?: unknown): Promise<void>;
};

function model(
  id: string,
  displaySize: string,
  sizeBytes: number,
  notes?: string,
): WhisperModelDefinition {
  return {
    id,
    filename: `ggml-${id}.bin`,
    displaySize,
    sizeBytes,
    multilingual: !id.includes(".en"),
    quantized: /-q[0-9]_/.test(id),
    notes,
  };
}

/** Catálogo oficial publicado para whisper.cpp. */
export const WHISPER_MODEL_CATALOG: readonly WhisperModelDefinition[] = [
  model("tiny-q5_1", "31 MiB", 31 * MiB, "Muy rápido, menor precisión"),
  model("tiny-q8_0", "42 MiB", 42 * MiB),
  model("tiny", "75 MiB", 75 * MiB),
  model("tiny.en-q5_1", "31 MiB", 31 * MiB, "Solo inglés"),
  model("tiny.en-q8_0", "42 MiB", 42 * MiB, "Solo inglés"),
  model("tiny.en", "75 MiB", 75 * MiB, "Solo inglés"),
  model("base-q5_1", "57 MiB", 57 * MiB, "Predeterminado recomendado"),
  model("base-q8_0", "78 MiB", 78 * MiB),
  model("base", "142 MiB", 142 * MiB),
  model("base.en-q5_1", "57 MiB", 57 * MiB, "Solo inglés"),
  model("base.en-q8_0", "78 MiB", 78 * MiB, "Solo inglés"),
  model("base.en", "142 MiB", 142 * MiB, "Solo inglés"),
  model("small-q5_1", "181 MiB", 181 * MiB, "Mejor precisión, más lento"),
  model("small-q8_0", "252 MiB", 252 * MiB),
  model("small", "466 MiB", 466 * MiB),
  model("small.en-q5_1", "181 MiB", 181 * MiB, "Solo inglés"),
  model("small.en-q8_0", "252 MiB", 252 * MiB, "Solo inglés"),
  model("small.en", "466 MiB", 466 * MiB, "Solo inglés"),
  model("small.en-tdrz", "465 MiB", 465 * MiB, "Solo inglés · diarización local"),
  model("medium-q5_0", "514 MiB", 514 * MiB),
  model("medium-q8_0", "785 MiB", 785 * MiB),
  model("medium", "1.5 GiB", 1.5 * GiB),
  model("medium.en-q5_0", "514 MiB", 514 * MiB, "Solo inglés"),
  model("medium.en-q8_0", "785 MiB", 785 * MiB, "Solo inglés"),
  model("medium.en", "1.5 GiB", 1.5 * GiB, "Solo inglés"),
  model("large-v1", "2.9 GiB", 2.9 * GiB),
  model("large-v2-q5_0", "1.1 GiB", 1.1 * GiB),
  model("large-v2-q8_0", "1.5 GiB", 1.5 * GiB),
  model("large-v2", "2.9 GiB", 2.9 * GiB),
  model("large-v3-q5_0", "1.1 GiB", 1.1 * GiB),
  model("large-v3", "2.9 GiB", 2.9 * GiB),
  model("large-v3-turbo-q5_0", "547 MiB", 547 * MiB, "Rápido y preciso"),
  model("large-v3-turbo-q8_0", "834 MiB", 834 * MiB),
  model("large-v3-turbo", "1.5 GiB", 1.5 * GiB),
] as const;

export const DEFAULT_WHISPER_MODEL_ID = "base-q5_1";

export interface WhisperConfig {
  version: 1;
  modelId: string;
  language: string;
  translateToEnglish: boolean;
  threads: number;
  bestOf: number;
  beamSize: number;
  temperature: number;
  noSpeechThreshold: number;
  maxAudioSeconds: number;
  timeoutSeconds: number;
}

export const DEFAULT_WHISPER_CONFIG: WhisperConfig = {
  version: 1,
  modelId: DEFAULT_WHISPER_MODEL_ID,
  language: "es",
  translateToEnglish: false,
  threads: 0,
  bestOf: 5,
  beamSize: 5,
  temperature: 0,
  noSpeechThreshold: 0.6,
  maxAudioSeconds: 120,
  timeoutSeconds: 900,
};

export function getWhisperConfigPath(): string {
  return join(getAppDir(), "persistent", "whisper.json");
}

export function getWhisperModelsDir(): string {
  return join(getAppDir(), "persistent", "whisper", "models");
}

export function getWhisperModel(modelId: string): WhisperModelDefinition | undefined {
  return WHISPER_MODEL_CATALOG.find((candidate) => candidate.id === modelId);
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function normalizeLanguage(value: unknown, modelId: string): string {
  const modelDefinition = getWhisperModel(modelId);
  if (modelDefinition && !modelDefinition.multilingual) return "en";
  if (typeof value !== "string") return DEFAULT_WHISPER_CONFIG.language;
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto") return "auto";
  return /^[a-z]{2,3}$/.test(normalized) ? normalized : DEFAULT_WHISPER_CONFIG.language;
}

export function normalizeWhisperConfig(value: unknown): WhisperConfig {
  const raw = value && typeof value === "object" ? value as Partial<WhisperConfig> : {};
  const modelId = getWhisperModel(String(raw.modelId ?? ""))?.id ?? DEFAULT_WHISPER_MODEL_ID;
  return {
    version: 1,
    modelId,
    language: normalizeLanguage(raw.language, modelId),
    translateToEnglish: raw.translateToEnglish === true,
    threads: boundedInteger(raw.threads, DEFAULT_WHISPER_CONFIG.threads, 0, 32),
    bestOf: boundedInteger(raw.bestOf, DEFAULT_WHISPER_CONFIG.bestOf, 1, 10),
    beamSize: boundedInteger(raw.beamSize, DEFAULT_WHISPER_CONFIG.beamSize, 1, 10),
    temperature: boundedNumber(raw.temperature, DEFAULT_WHISPER_CONFIG.temperature, 0, 1),
    noSpeechThreshold: boundedNumber(raw.noSpeechThreshold, DEFAULT_WHISPER_CONFIG.noSpeechThreshold, 0, 1),
    maxAudioSeconds: boundedInteger(raw.maxAudioSeconds, DEFAULT_WHISPER_CONFIG.maxAudioSeconds, 30, 600),
    timeoutSeconds: boundedInteger(raw.timeoutSeconds, DEFAULT_WHISPER_CONFIG.timeoutSeconds, 60, 3600),
  };
}

export function loadWhisperConfig(path = getWhisperConfigPath()): WhisperConfig {
  try {
    return normalizeWhisperConfig(readJsonFile<unknown>(path));
  } catch (error) {
    console.warn("[whisper] No se pudo leer whisper.json; usando valores seguros:", error);
    return { ...DEFAULT_WHISPER_CONFIG };
  }
}

export function saveWhisperConfig(
  config: WhisperConfig,
  path = getWhisperConfigPath(),
): WhisperConfig {
  const normalized = normalizeWhisperConfig(config);
  writeJsonFileAtomically(path, normalized);
  return normalized;
}

export function getDownloadedWhisperModelPath(modelId: string): string {
  const definition = getWhisperModel(modelId);
  if (!definition) throw new Error(`Modelo Whisper desconocido: ${modelId}`);
  return join(getWhisperModelsDir(), definition.filename);
}

function packagedModelCandidates(filename: string): string[] {
  return [
    join(dirname(process.execPath), "runtime", "whisper", "models", filename),
    join(process.cwd(), "assets", "runtime", "whisper", "models", filename),
    resolve(dirname(Bun.main), "..", "assets", "runtime", "whisper", "models", filename),
  ];
}

export function findAvailableWhisperModel(modelId: string): string | null {
  const definition = getWhisperModel(modelId);
  if (!definition) return null;
  const candidates = [
    getDownloadedWhisperModelPath(modelId),
    ...packagedModelCandidates(definition.filename),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

export function isWhisperModelAvailable(modelId: string): boolean {
  return findAvailableWhisperModel(modelId) !== null;
}

export function listDownloadedWhisperModels(): WhisperModelDefinition[] {
  return WHISPER_MODEL_CATALOG.filter((entry) => existsSync(getDownloadedWhisperModelPath(entry.id)));
}

export function deleteDownloadedWhisperModelsExcept(modelId: string): number {
  let deleted = 0;
  for (const entry of WHISPER_MODEL_CATALOG) {
    if (entry.id === modelId) continue;
    const path = getDownloadedWhisperModelPath(entry.id);
    if (!existsSync(path)) continue;
    rmSync(path, { force: true });
    deleted += 1;
  }
  return deleted;
}

type HfTreeEntry = {
  path?: string;
  rfilename?: string;
  size?: number;
  lfs?: { oid?: string; size?: number };
};

type RemoteModelMetadata = {
  size: number;
  sha256: string;
  downloadUrl: string;
};

export type WhisperDownloadProgress = {
  model: WhisperModelDefinition;
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
};

const HF_TREE_API = "https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main?recursive=false&expand=false";
const HF_RESOLVE_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const DOWNLOAD_CONNECT_TIMEOUT_MS = 30_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
const DOWNLOAD_TOTAL_TIMEOUT_MS = 3 * 60 * 60_000;
let activeDownload: Promise<string> | null = null;

function parseSha256(value: string | null | undefined): string | null {
  const clean = value?.trim().replace(/^W\//, "").replace(/^"|"$/g, "").replace(/^sha256:/, "");
  return clean && /^[a-f0-9]{64}$/i.test(clean) ? clean.toLowerCase() : null;
}

async function fetchModelMetadata(modelDefinition: WhisperModelDefinition): Promise<RemoteModelMetadata> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_CONNECT_TIMEOUT_MS);
  try {
    const response = await fetch(HF_TREE_API, {
      headers: { "User-Agent": `Luna-AI/Bun-${Bun.version}` },
      signal: controller.signal,
    });
    if (response.ok) {
      const entries = await response.json() as HfTreeEntry[];
      const entry = entries.find((candidate) =>
        (candidate.path ?? candidate.rfilename) === modelDefinition.filename
      );
      const sha256 = parseSha256(entry?.lfs?.oid);
      const size = Number(entry?.lfs?.size ?? entry?.size);
      if (sha256 && Number.isFinite(size) && size > 0) {
        return {
          size,
          sha256,
          downloadUrl: `${HF_RESOLVE_BASE}/${encodeURIComponent(modelDefinition.filename)}?download=true`,
        };
      }
    }
  } catch {
    // La consulta de metadatos puede fallar por red o rate limit; intentar HEAD.
  } finally {
    clearTimeout(timer);
  }

  const downloadUrl = `${HF_RESOLVE_BASE}/${encodeURIComponent(modelDefinition.filename)}?download=true`;
  const headController = new AbortController();
  const headTimer = setTimeout(() => headController.abort(), DOWNLOAD_CONNECT_TIMEOUT_MS);
  try {
    const response = await fetch(downloadUrl, {
      method: "HEAD",
      redirect: "follow",
      headers: { "Accept-Encoding": "identity", "User-Agent": `Luna-AI/Bun-${Bun.version}` },
      signal: headController.signal,
    });
    if (!response.ok) throw new Error(`Hugging Face respondió HTTP ${response.status}.`);
    const sha256 = parseSha256(response.headers.get("x-linked-etag"));
    const size = Number(response.headers.get("x-linked-size") ?? response.headers.get("content-length"));
    if (!sha256 || !Number.isFinite(size) || size <= 0) {
      throw new Error("Hugging Face no publicó metadatos SHA-256 verificables para el modelo.");
    }
    return { size, sha256, downloadUrl };
  } finally {
    clearTimeout(headTimer);
  }
}

async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

function ensureDiskSpace(destination: string, expectedSize: number): void {
  try {
    mkdirSync(dirname(destination), { recursive: true });
    const stats = statfsSync(dirname(destination));
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const required = Math.ceil(expectedSize * 1.15);
    if (Number.isFinite(freeBytes) && freeBytes < required) {
      throw new Error(
        `Espacio insuficiente. Se requieren aproximadamente ${(required / GiB).toFixed(2)} GiB libres.`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Espacio insuficiente")) throw error;
    // Algunos filesystems no exponen statfs; la descarga aún puede intentarse.
  }
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset, null);
    if (written <= 0) throw new Error("No se pudo escribir el modelo en disco.");
    offset += written;
  }
}

async function readWithIdleTimeout(
  reader: ByteStreamReader,
  controller: AbortController,
): Promise<ByteStreamReadResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("La descarga no recibió datos durante 60 segundos."));
        }, DOWNLOAD_IDLE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function downloadModelInternal(
  modelDefinition: WhisperModelDefinition,
  onProgress?: (progress: WhisperDownloadProgress) => void | Promise<void>,
): Promise<string> {
  const existing = findAvailableWhisperModel(modelDefinition.id);
  if (existing) return existing;

  const metadata = await fetchModelMetadata(modelDefinition);
  const destination = getDownloadedWhisperModelPath(modelDefinition.id);
  const temporary = `${destination}.download`;
  ensureDiskSpace(destination, metadata.size);
  mkdirSync(dirname(destination), { recursive: true });

  if (existsSync(destination)) {
    const currentHash = await sha256File(destination);
    if (currentHash === metadata.sha256) return destination;
    unlinkSync(destination);
  }

  let existingBytes = existsSync(temporary) ? statSync(temporary).size : 0;
  if (existingBytes > metadata.size) {
    unlinkSync(temporary);
    existingBytes = 0;
  }

  const headers: Record<string, string> = {
    Accept: "application/octet-stream",
    "Accept-Encoding": "identity",
    "User-Agent": `Luna-AI/Bun-${Bun.version}`,
  };
  if (existingBytes > 0) headers.Range = `bytes=${existingBytes}-`;

  const controller = new AbortController();
  let timeoutReason: "connect" | "total" | undefined;
  const connectTimer = setTimeout(() => {
    timeoutReason = "connect";
    controller.abort();
  }, DOWNLOAD_CONNECT_TIMEOUT_MS);
  const totalTimer = setTimeout(() => {
    timeoutReason = "total";
    controller.abort();
  }, DOWNLOAD_TOTAL_TIMEOUT_MS);
  let reader: ByteStreamReader | undefined;
  let fd: number | undefined;

  try {
    const response = await fetch(metadata.downloadUrl, {
      redirect: "follow",
      headers,
      signal: controller.signal,
      keepalive: false,
      decompress: false,
    } as RequestInit & { decompress: boolean });
    clearTimeout(connectTimer);
    if (response.status === 416 && existingBytes === metadata.size) {
      const digest = await sha256File(temporary);
      if (digest === metadata.sha256) {
        rmSync(destination, { force: true });
        renameSync(temporary, destination);
        return destination;
      }
      rmSync(temporary, { force: true });
      throw new Error("La descarga parcial completa no superó la verificación SHA-256.");
    }
    if (!response.ok || !response.body) {
      throw new Error(`Hugging Face respondió HTTP ${response.status}.`);
    }

    const resumed = existingBytes > 0 && response.status === 206;
    if (!resumed) existingBytes = 0;
    const openedFd = openSync(temporary, resumed ? "a" : "w");
    fd = openedFd;
    const responseReader: ByteStreamReader = response.body.getReader();
    reader = responseReader;
    let downloadedBytes = existingBytes;
    let lastReportedPercent = -1;

    while (true) {
      const { done, value } = await readWithIdleTimeout(responseReader, controller);
      if (done) break;
      if (!value?.byteLength) continue;
      writeAll(openedFd, value);
      downloadedBytes += value.byteLength;
      const percent = Math.min(100, Math.floor((downloadedBytes / metadata.size) * 100));
      if (percent >= lastReportedPercent + 5 || percent === 100) {
        lastReportedPercent = percent;
        try {
          await onProgress?.({ model: modelDefinition, downloadedBytes, totalBytes: metadata.size, percent });
        } catch (error) {
          console.warn("[whisper] No se pudo enviar el progreso de descarga:", error);
        }
      }
    }

    if (fd !== undefined) {
      closeSync(fd);
      fd = undefined;
    }
    if (downloadedBytes !== metadata.size) {
      throw new Error(`Descarga incompleta: ${downloadedBytes} de ${metadata.size} bytes.`);
    }
    const digest = await sha256File(temporary);
    if (digest !== metadata.sha256) {
      rmSync(temporary, { force: true });
      throw new Error(`SHA-256 inválido para ${modelDefinition.filename}.`);
    }
    rmSync(destination, { force: true });
    renameSync(temporary, destination);
    return destination;
  } catch (error) {
    if (timeoutReason === "connect") {
      throw new Error("Hugging Face no respondió en 30 segundos.", { cause: error });
    }
    if (timeoutReason === "total") {
      throw new Error("La descarga excedió tres horas y fue cancelada.", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(connectTimer);
    clearTimeout(totalTimer);
    try {
      await reader?.cancel();
    } catch {
      // La respuesta ya terminó.
    }
    if (fd !== undefined) closeSync(fd);
  }
}

export async function downloadWhisperModel(
  modelId: string,
  onProgress?: (progress: WhisperDownloadProgress) => void | Promise<void>,
): Promise<string> {
  const modelDefinition = getWhisperModel(modelId);
  if (!modelDefinition) throw new Error(`Modelo Whisper desconocido: ${modelId}`);
  if (activeDownload) {
    throw new Error("Ya hay una descarga de modelo Whisper en curso.");
  }
  const task = downloadModelInternal(modelDefinition, onProgress);
  activeDownload = task;
  try {
    return await task;
  } finally {
    if (activeDownload === task) activeDownload = null;
  }
}
