import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";

export type WhisperRuntimeManifest = {
  schemaVersion: 1;
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  assetName: string;
  assetDigest: string;
  executable: string;
  model: string;
  libraryDirs: string[];
  preparedAt: string;
};

export type WhisperRuntime = {
  root: string;
  executable: string;
  model: string;
  libraryDirs: string[];
  manifest: WhisperRuntimeManifest;
};

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

function pathInside(root: string, relativePath: string): string {
  const normalizedRoot = resolve(root);
  const path = resolve(normalizedRoot, relativePath);
  if (path !== normalizedRoot && !path.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error("El manifiesto de whisper.cpp contiene una ruta insegura.");
  }
  return path;
}

function runtimeCandidates(): string[] {
  const configured = process.env.LUNA_WHISPER_RUNTIME_DIR?.trim();
  const candidates = [
    configured ? resolve(configured) : "",
    join(dirname(process.execPath), "runtime", "whisper"),
    join(process.cwd(), "assets", "runtime", "whisper"),
    resolve(dirname(Bun.main), "..", "assets", "runtime", "whisper"),
  ].filter(Boolean);
  return [...new Set(candidates)];
}

export function loadWhisperRuntime(candidates = runtimeCandidates()): WhisperRuntime {
  for (const root of candidates) {
    const manifestPath = join(root, "manifest.json");
    if (!existsSync(manifestPath)) continue;

    let manifest: WhisperRuntimeManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as WhisperRuntimeManifest;
    } catch {
      continue;
    }

    if (
      manifest.schemaVersion !== 1
      || manifest.platform !== process.platform
      || manifest.arch !== process.arch
      || !Array.isArray(manifest.libraryDirs)
    ) {
      continue;
    }

    const executable = pathInside(root, manifest.executable);
    const model = pathInside(root, manifest.model);
    const libraryDirs = manifest.libraryDirs.map((path) => pathInside(root, path));
    if (!existsSync(executable) || !existsSync(model)) continue;

    return { root, executable, model, libraryDirs, manifest };
  }

  throw new Error(
    "No se encontró el runtime de whisper.cpp para este sistema. " +
      "Ejecuta bun run prepare:media o distribuye la carpeta runtime junto al binario de Luna.",
  );
}

export function encodePcm16Wav(samples: Float32Array, sampleRate = 16_000): Uint8Array {
  const dataLength = samples.length * 2;
  const bytes = new Uint8Array(44 + dataLength);
  const view = new DataView(bytes.buffer);

  const writeAscii = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataLength, true);

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    const pcm = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    view.setInt16(44 + index * 2, pcm, true);
  }

  return bytes;
}

export function buildWhisperArguments(
  runtime: WhisperRuntime,
  inputWav: string,
  outputPrefix: string,
  threads = Math.max(1, Math.min(8, availableParallelism())),
): string[] {
  return [
    runtime.executable,
    "--model", runtime.model,
    "--file", inputWav,
    "--language", "es",
    "--threads", String(threads),
    "--output-txt",
    "--output-file", outputPrefix,
    "--no-timestamps",
    "--no-prints",
    "--no-gpu",
  ];
}

function whisperEnvironment(runtime: WhisperRuntime): Record<string, string | undefined> {
  const existingPath = process.env.PATH ?? "";
  const libraryPath = runtime.libraryDirs.join(delimiter);
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: [libraryPath, existingPath].filter(Boolean).join(delimiter),
  };

  if (process.platform === "linux") {
    env.LD_LIBRARY_PATH = [libraryPath, process.env.LD_LIBRARY_PATH ?? ""].filter(Boolean).join(delimiter);
  }
  if (process.platform === "darwin") {
    env.DYLD_LIBRARY_PATH = [libraryPath, process.env.DYLD_LIBRARY_PATH ?? ""].filter(Boolean).join(delimiter);
  }
  return env;
}

export async function transcribeWithWhisperCli(
  samples: Float32Array,
  options: { timeoutMs?: number; runtime?: WhisperRuntime } = {},
): Promise<string> {
  if (samples.length === 0) throw new Error("El audio no contiene muestras para transcribir.");
  const runtime = options.runtime ?? loadWhisperRuntime();
  const temporaryDir = mkdtempSync(join(tmpdir(), "luna-whisper-"));
  const inputWav = join(temporaryDir, "audio.wav");
  const outputPrefix = join(temporaryDir, "transcript");
  const outputText = `${outputPrefix}.txt`;
  writeFileSync(inputWav, encodePcm16Wav(samples));

  const command = buildWhisperArguments(runtime, inputWav, outputPrefix);
  const child = Bun.spawn(command, {
    cwd: runtime.root,
    env: whisperEnvironment(runtime),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const stdoutPromise = child.stdout ? new Response(child.stdout).text() : Promise.resolve("");
  const stderrPromise = child.stderr ? new Response(child.stderr).text() : Promise.resolve("");
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill();
    } catch {
      // El proceso ya pudo finalizar.
    }
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const exitCode = await child.exited;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    if (timedOut) throw new Error("La transcripción local excedió 10 minutos y fue cancelada.");
    if (exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim() || `código ${exitCode}`;
      throw new Error(`whisper.cpp no pudo transcribir el audio: ${detail.slice(-1_500)}`);
    }

    const text = existsSync(outputText)
      ? readFileSync(outputText, "utf8").trim()
      : stdout.trim();
    if (!text) throw new Error("whisper.cpp terminó sin producir una transcripción.");
    return text;
  } finally {
    clearTimeout(timeout);
    rmSync(temporaryDir, { recursive: true, force: true });
  }
}
