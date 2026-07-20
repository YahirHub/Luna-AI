import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export type FfmpegRuntimeManifest = {
  schemaVersion: 1;
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  assetName: string;
  assetDigest: string;
  executable: string;
  preparedAt: string;
};

export type FfmpegRuntime = {
  root: string;
  executable: string;
  manifest: FfmpegRuntimeManifest;
};

function pathInside(root: string, relativePath: string): string {
  const normalizedRoot = resolve(root);
  const path = resolve(normalizedRoot, relativePath);
  if (path !== normalizedRoot && !path.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error("El manifiesto de FFmpeg contiene una ruta insegura.");
  }
  return path;
}

function runtimeCandidates(): string[] {
  const configured = process.env.LUNA_FFMPEG_RUNTIME_DIR?.trim();
  const candidates = [
    configured ? resolve(configured) : "",
    join(dirname(process.execPath), "runtime", "ffmpeg"),
    join(process.cwd(), "assets", "runtime", "ffmpeg"),
    resolve(dirname(Bun.main), "..", "assets", "runtime", "ffmpeg"),
  ].filter(Boolean);
  return [...new Set(candidates)];
}

export function loadFfmpegRuntime(candidates = runtimeCandidates()): FfmpegRuntime {
  for (const root of candidates) {
    const manifestPath = join(root, "manifest.json");
    if (!existsSync(manifestPath)) continue;

    let manifest: FfmpegRuntimeManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as FfmpegRuntimeManifest;
    } catch {
      continue;
    }

    if (
      manifest.schemaVersion !== 1
      || manifest.platform !== process.platform
      || manifest.arch !== process.arch
    ) {
      continue;
    }

    const executable = pathInside(root, manifest.executable);
    if (!existsSync(executable)) continue;
    return { root, executable, manifest };
  }

  throw new Error(
    "No se encontró el runtime de FFmpeg para este sistema. " +
      "Ejecuta bun run prepare:media o distribuye la carpeta runtime junto al binario de Luna.",
  );
}

function audioExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.startsWith("audio/ogg")) return ".ogg";
  if (normalized.startsWith("audio/opus")) return ".opus";
  return ".audio";
}

function float32FromLittleEndian(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 4 !== 0) {
    throw new Error("FFmpeg produjo PCM Float32 con una longitud inválida.");
  }

  // Los runtimes soportados actualmente son little-endian. Copiamos el rango
  // exacto para evitar que un Buffer compartido exponga bytes ajenos al PCM.
  const exact = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Float32Array(exact);
}

export async function decodeAudioWithFfmpeg(
  encodedBytes: Uint8Array,
  mimeType: string,
  options: {
    runtime?: FfmpegRuntime;
    timeoutMs?: number;
  } = {},
): Promise<Float32Array> {
  if (encodedBytes.byteLength === 0) throw new Error("El audio recibido está vacío.");

  const runtime = options.runtime ?? loadFfmpegRuntime();
  const temporaryDir = mkdtempSync(join(tmpdir(), "luna-ffmpeg-"));
  const input = join(temporaryDir, `input${audioExtension(mimeType)}`);
  const output = join(temporaryDir, "audio.f32le");
  writeFileSync(input, encodedBytes);

  const args = [
    runtime.executable,
    "-hide_banner",
    "-loglevel", "warning",
    "-nostdin",
    "-y",
    "-fflags", "+discardcorrupt",
    "-err_detect", "ignore_err",
    "-i", input,
    "-map", "0:a:0",
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "pcm_f32le",
    "-f", "f32le",
    output,
  ];

  const child = Bun.spawn(args, {
    cwd: runtime.root,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const stdoutPromise = child.stdout ? new Response(child.stdout).text() : Promise.resolve("");
  const stderrPromise = child.stderr ? new Response(child.stderr).text() : Promise.resolve("");
  let timedOut = false;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill();
    } catch {
      // El proceso ya pudo finalizar.
    }
  }, timeoutMs);

  try {
    const exitCode = await child.exited;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    if (timedOut) {
      throw new Error(`FFmpeg excedió ${Math.ceil(timeoutMs / 1000)} segundos al decodificar el audio.`);
    }
    if (exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim() || `código ${exitCode}`;
      throw new Error(`FFmpeg no pudo decodificar el audio: ${detail.slice(-1_500)}`);
    }
    if (!existsSync(output)) throw new Error("FFmpeg terminó sin producir audio PCM.");

    const pcm = new Uint8Array(readFileSync(output));
    const samples = float32FromLittleEndian(pcm);
    if (samples.length === 0) throw new Error("FFmpeg no produjo muestras de audio válidas.");
    return samples;
  } finally {
    clearTimeout(timeout);
    rmSync(temporaryDir, { recursive: true, force: true });
  }
}
