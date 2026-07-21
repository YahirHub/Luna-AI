import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { getAppDir } from "../utils.ts";

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

export interface FfmpegRuntime {
  executable: string;
  manifest?: FfmpegRuntimeManifest;
}

function executableName(): string {
  return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

export function loadFfmpegRuntime(): FfmpegRuntime {
  const name = executableName();
  const roots = [
    join(getAppDir(), "runtime", "ffmpeg"),
    join(process.cwd(), "dist", "runtime", "ffmpeg"),
    join(process.cwd(), "assets", "runtime", "ffmpeg"),
  ];
  for (const root of roots) {
    const executable = join(root, name);
    if (!existsSync(executable)) continue;
    let manifest: FfmpegRuntimeManifest | undefined;
    try { manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as FfmpegRuntimeManifest; } catch { /* manifest opcional */ }
    return { executable, manifest };
  }
  throw new Error("No se encontró el runtime administrado de FFmpeg. Ejecuta bun run prepare:media.");
}

export interface DecodeAudioOptions {
  runtime?: FfmpegRuntime;
  timeoutMs?: number;
  expectedDurationSeconds?: number | null;
}

function float32FromBuffer(buffer: Buffer): Float32Array {
  if (buffer.byteLength % 4 !== 0) throw new Error("FFmpeg produjo PCM Float32 incompleto.");
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return new Float32Array(copy.buffer);
}

export async function decodeOggOpusToMono16k(
  encoded: Uint8Array,
  options: DecodeAudioOptions = {},
): Promise<{ samples: Float32Array; durationSeconds: number }> {
  const runtime = options.runtime ?? loadFfmpegRuntime();
  const directory = mkdtempSync(join(tmpdir(), "luna-ffmpeg-"));
  const input = join(directory, "audio.ogg");
  const output = join(directory, "audio.f32le");
  writeFileSync(input, encoded);

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const timer = setTimeout(() => controller.abort(new Error("ffmpeg-timeout")), timeoutMs);
  try {
    const child = Bun.spawn([
      runtime.executable,
      "-hide_banner", "-loglevel", "warning", "-nostdin", "-y",
      "-fflags", "+discardcorrupt", "-err_detect", "ignore_err",
      "-i", input,
      "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000",
      "-c:a", "pcm_f32le", "-f", "f32le", output,
    ], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      signal: controller.signal,
    });
    const stdoutPromise = child.stdout ? new Response(child.stdout).text() : Promise.resolve("");
    const stderrPromise = child.stderr ? new Response(child.stderr).text() : Promise.resolve("");
    const exitCode = await child.exited;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    if (exitCode !== 0 || !existsSync(output)) {
      throw new Error(`FFmpeg no pudo decodificar el audio: ${(stderr || stdout || `código ${exitCode}`).trim().slice(-1800)}`);
    }

    const samples = float32FromBuffer(readFileSync(output));
    const durationSeconds = samples.length / 16_000;
    if (durationSeconds <= 0) throw new Error("FFmpeg no produjo muestras de audio válidas.");
    const expected = options.expectedDurationSeconds;
    if (expected && expected > 0) {
      const missing = expected - durationSeconds;
      const tolerance = Math.max(2, expected * 0.06);
      if (missing > tolerance) {
        throw new Error(
          `La decodificación se truncó: el OGG dura aproximadamente ${expected.toFixed(1)} s, ` +
          `pero FFmpeg solo produjo ${durationSeconds.toFixed(1)} s.`,
        );
      }
    }
    return { samples, durationSeconds };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`FFmpeg excedió ${Math.round(timeoutMs / 1000)} segundos.`);
    throw error;
  } finally {
    clearTimeout(timer);
    rmSync(directory, { recursive: true, force: true });
  }
}

export function ffmpegRuntimeDescription(runtime = loadFfmpegRuntime()): string {
  return `${basename(runtime.executable)} (${runtime.manifest?.version ?? "versión desconocida"}) en ${dirname(runtime.executable)}`;
}
