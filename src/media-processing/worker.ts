import { gunzipSync } from "node:zlib";
import { OggOpusDecoder } from "ogg-opus-decoder";
import { decode as decodeJpeg } from "jpeg-js";
import { PNG } from "pngjs";
import { createOCREngine, supportsFastBuild, type OCREngine } from "tesseract-wasm";
import tesseractFastPath from "../../assets/runtime/tesseract/tesseract-core.wasm" with { type: "file" };
import tesseractFallbackPath from "../../assets/runtime/tesseract/tesseract-core-fallback.wasm" with { type: "file" };
import spanishModelPath from "../../assets/runtime/ocr/spa.traineddata.gz" with { type: "file" };
import type { MediaWorkerRequest, MediaWorkerResponse } from "./protocol.ts";
import { downsampleTo16k, estimateOggDurationSeconds, mixToMono } from "./audio-utils.ts";
import { readImageDimensions } from "./image-utils.ts";
import { transcribeWithWhisperCli } from "./whisper-native.ts";
import { loadWhisperConfig } from "../whisper-config.ts";

const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_EXTRACTED_TEXT_CHARS = 20_000;
let ocrEnginePromise: Promise<OCREngine> | null = null;
let queue = Promise.resolve();

function post(message: MediaWorkerResponse): void {
  if (typeof process.send !== "function") {
    throw new Error("El proceso multimedia no tiene un canal IPC activo.");
  }
  process.send(message);
}

async function readEmbeddedBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

async function getOcrEngine(): Promise<OCREngine> {
  if (!ocrEnginePromise) {
    ocrEnginePromise = (async () => {
      const wasmPath = supportsFastBuild() ? tesseractFastPath : tesseractFallbackPath;
      const wasmBinary = await readEmbeddedBytes(wasmPath);
      const engine = await createOCREngine({ wasmBinary });
      const compressedModel = await readEmbeddedBytes(spanishModelPath);
      engine.loadModel(gunzipSync(compressedModel));
      engine.setVariable("preserve_interword_spaces", "1");
      return engine;
    })().catch((error) => {
      ocrEnginePromise = null;
      throw error;
    });
  }
  return ocrEnginePromise;
}

async function transcribeAudio(request: MediaWorkerRequest): Promise<{ text: string; durationSeconds: number }> {
  if (!/^(audio\/ogg|audio\/opus)(;|$)/i.test(request.mimeType)) {
    throw new Error("Solo se admiten notas de voz OGG/Opus.");
  }

  const config = loadWhisperConfig();
  const encodedBytes = new Uint8Array(request.bytes);
  const estimatedDuration = estimateOggDurationSeconds(encodedBytes);
  if (estimatedDuration !== null && estimatedDuration > config.maxAudioSeconds) {
    throw new Error(`El audio supera el límite de ${config.maxAudioSeconds} segundos.`);
  }

  const decoder = new OggOpusDecoder();
  await decoder.ready;
  try {
    const decoded = await decoder.decodeFile(encodedBytes);
    const mono = downsampleTo16k(mixToMono(decoded.channelData), decoded.sampleRate);
    const durationSeconds = mono.length / 16_000;
    if (durationSeconds <= 0) throw new Error("El audio no contiene muestras válidas.");
    if (durationSeconds > config.maxAudioSeconds) {
      throw new Error(`El audio supera el límite de ${config.maxAudioSeconds} segundos.`);
    }

    const text = await transcribeWithWhisperCli(mono, { config });
    return { text, durationSeconds };
  } finally {
    decoder.free();
  }
}

type RawImageData = { width: number; height: number; data: Uint8ClampedArray };

function decodeImage(bytes: Uint8Array, mimeType: string): RawImageData {
  const dimensions = readImageDimensions(bytes, mimeType);
  if (!dimensions) throw new Error("La imagen no tiene una cabecera JPEG o PNG válida.");
  if (dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
    throw new Error("La imagen supera el límite de 16 megapíxeles para OCR.");
  }

  if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
    const decoded = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true });
    return {
      width: decoded.width,
      height: decoded.height,
      data: new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
    };
  }
  if (mimeType === "image/png") {
    const decoded = PNG.sync.read(Buffer.from(bytes));
    return {
      width: decoded.width,
      height: decoded.height,
      data: new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
    };
  }
  throw new Error("El OCR local solo admite imágenes JPEG y PNG.");
}

async function recognizeImage(request: MediaWorkerRequest): Promise<string> {
  const image = decodeImage(new Uint8Array(request.bytes), request.mimeType.toLowerCase());
  const engine = await getOcrEngine();
  engine.clearImage();
  engine.loadImage(image);
  return engine.getText()
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim()
    .slice(0, MAX_EXTRACTED_TEXT_CHARS);
}

async function processRequest(request: MediaWorkerRequest): Promise<void> {
  try {
    if (request.type === "transcribe-audio") {
      const result = await transcribeAudio(request);
      post({ id: request.id, type: "result", text: result.text, durationSeconds: result.durationSeconds });
      return;
    }
    const text = await recognizeImage(request);
    post({ id: request.id, type: "result", text });
  } catch (error) {
    post({ id: request.id, type: "error", error: error instanceof Error ? error.message : String(error) });
  }
}

function isMediaRequest(value: unknown): value is MediaWorkerRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<MediaWorkerRequest>;
  return typeof request.id === "string"
    && (request.type === "transcribe-audio" || request.type === "ocr-image")
    && typeof request.mimeType === "string"
    && request.bytes instanceof Uint8Array;
}

/**
 * Ejecuta el procesador multimedia como un subproceso persistente del mismo
 * binario. El aislamiento conserva WhatsApp responsivo y evita depender de
 * rutas de Worker que Bun 1.3.14 resuelve contra src/ en Windows standalone.
 */
export async function runMediaProcessorChild(): Promise<void> {
  if (typeof process.send !== "function") {
    throw new Error("El modo multimedia requiere iniciarse mediante IPC.");
  }

  process.on("message", (message: unknown) => {
    if (!isMediaRequest(message)) return;
    queue = queue.then(
      () => processRequest(message),
      () => processRequest(message),
    );
  });

  // Mantener el subproceso activo mientras exista el canal IPC.
  await new Promise<void>((resolve) => {
    process.once("disconnect", resolve);
  });
}
