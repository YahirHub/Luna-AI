import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { debugInfo, debugWarn } from "../debug.ts";
import { getAppDir } from "../utils.ts";

export interface PiperNeoRuntimeManifest {
  schemaVersion: 1;
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  assetName: string;
  assetDigest?: string;
  executable: string;
  preparedAt: string;
}

export interface PiperNeoRuntime {
  executable: string;
  root: string;
  manifest?: PiperNeoRuntimeManifest;
}

export interface PiperSynthesisRequest {
  text: string;
  modelPath: string;
  configPath?: string;
  voiceId?: string;
  speakerId?: number;
  lengthScale?: number;
  noiseScale?: number;
  noiseWScale?: number;
  signal?: AbortSignal;
}

interface PiperApiEnvelope<T> {
  success?: boolean;
  message?: string;
  error?: string;
  data?: T;
}

interface PiperApiHealthData {
  status?: string;
  model_loaded?: boolean;
}

interface PiperApiTtsData {
  file?: string;
  model?: string;
  url?: string;
  format?: string;
  chunks?: number;
  bytes?: number;
  audio_seconds?: number;
  infer_seconds?: number;
  real_time_factor?: number;
}

function findRuntime(): PiperNeoRuntime {
  const explicit = process.env.PIPER_NEO_EXECUTABLE_PATH?.trim();
  if (explicit) return { executable: resolve(explicit), root: dirname(resolve(explicit)) };
  const roots = [
    join(getAppDir(), "runtime", "piper-neo"),
    join(process.cwd(), "dist", "runtime", "piper-neo"),
    join(process.cwd(), "assets", "runtime", "piper-neo"),
  ];
  for (const root of roots) {
    const manifestPath = join(root, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PiperNeoRuntimeManifest;
      const executable = join(root, manifest.executable);
      if (manifest.schemaVersion === 1 && existsSync(executable)) return { executable, root, manifest };
    } catch { /* siguiente runtime */ }
  }
  throw new Error("No se encontró Piper Neo. Ejecuta bun run prepare:piper o define PIPER_NEO_EXECUTABLE_PATH.");
}

function shellArgs(value: string): string[] {
  const out: string[] = [];
  const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value))) out.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\"/g, '"'));
  return out;
}

function replacePlaceholders(args: string[], values: Record<string, string>): string[] {
  return args.map((arg) => arg.replace(/\{([a-z_]+)\}/gi, (_all, key: string) => values[key] ?? ""));
}

function walkDirs(root: string): string[] {
  const dirs = [root];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ".downloads") continue;
      const full = join(dir, entry.name);
      dirs.push(full);
      visit(full);
    }
  };
  try { visit(root); } catch { /* runtime mínimo */ }
  return dirs;
}

function runtimeEnv(runtime: PiperNeoRuntime): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (process.platform === "linux") {
    const dirs = walkDirs(runtime.root);
    env.LD_LIBRARY_PATH = [...dirs, ...(env.LD_LIBRARY_PATH ? [env.LD_LIBRARY_PATH] : [])].join(":");
  }
  if (process.platform === "win32") {
    const dirs = walkDirs(runtime.root);
    env.PATH = [...dirs, ...(env.PATH ? [env.PATH] : [])].join(";");
  }
  return env;
}

async function readHelp(runtime: PiperNeoRuntime): Promise<string> {
  const child = Bun.spawn([runtime.executable, "--help"], {
    cwd: runtime.root, env: runtimeEnv(runtime), stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const stdout = child.stdout ? new Response(child.stdout).text() : Promise.resolve("");
  const stderr = child.stderr ? new Response(child.stderr).text() : Promise.resolve("");
  await child.exited;
  return `${await stdout}\n${await stderr}`;
}

function serverArgsFromHelp(help: string, request: PiperSynthesisRequest, port: number): { args: string[]; port: number } | null {
  const modelsDir = dirname(request.modelPath);
  const explicit = process.env.PIPER_NEO_SERVER_ARGS?.trim();
  const values = {
    model: request.modelPath,
    models: modelsDir,
    models_dir: modelsDir,
    config: request.configPath ?? "",
    host: "127.0.0.1",
    port: String(port),
    voice: request.voiceId ?? "",
  };
  if (explicit) {
    return { args: replacePlaceholders(shellArgs(explicit), values).filter(Boolean), port };
  }

  const lower = help.toLowerCase();
  if (!lower.includes("--server")) return null;
  if (!lower.includes("--models")) {
    throw new Error("El runtime Piper Neo anuncia --server pero no --models. La API soportada por Luna requiere `piper --server --models <carpeta>`.");
  }

  const args = ["--server", "--models", modelsDir];
  let effectivePort = 8080; // Puerto documentado por Piper Neo cuando no hay override.
  if (lower.includes("--host")) args.push("--host", "127.0.0.1");
  if (lower.includes("--port")) {
    args.push("--port", String(port));
    effectivePort = port;
  } else if (lower.includes("--server-port")) {
    args.push("--server-port", String(port));
    effectivePort = port;
  }
  return { args, port: effectivePort };
}

function isWav(bytes: Uint8Array): boolean {
  return bytes.length > 44
    && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.subarray(8, 12)) === "WAVE";
}

function abortSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function apiToken(): string | undefined {
  return process.env.PIPER_NEO_API_TOKEN?.trim() || process.env.PIPER_API_TOKEN?.trim() || undefined;
}

function requestHeaders(contentType = false): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (contentType) headers["Content-Type"] = "application/json";
  const token = apiToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function safeJson<T>(response: Response): Promise<PiperApiEnvelope<T> | null> {
  const text = await response.text();
  if (!text.trim()) return null;
  try { return JSON.parse(text) as PiperApiEnvelope<T>; }
  catch { return { success: false, message: text.slice(0, 1200) }; }
}

function sameOriginFileUrl(baseUrl: string, value: string): URL {
  const base = new URL(`${baseUrl.replace(/\/$/, "")}/`);
  const target = new URL(value, base);
  if (target.origin !== base.origin) {
    throw new Error(`Piper Neo devolvió una URL de audio de otro origen (${target.origin}); se rechazó por seguridad.`);
  }
  if (!target.pathname.startsWith("/api/v1/files/")) {
    throw new Error(`Piper Neo devolvió una ruta de audio inesperada: ${target.pathname}`);
  }
  return target;
}

export class PiperNeoRuntimeManager {
  private runtime: PiperNeoRuntime | null = null;
  private help: string | null = null;
  private server: ReturnType<typeof Bun.spawn> | null = null;
  private serverModelsDir = "";
  private activeBaseUrl = "";
  private readonly requestedPort = Number.parseInt(process.env.PIPER_NEO_PORT ?? "19080", 10) || 19080;
  private readonly logsDir = join(getAppDir(), "persistent", "piper", "logs");

  description(): string {
    try {
      const runtime = this.getRuntime();
      return `${basename(runtime.executable)} ${runtime.manifest?.version ?? "externo"} (${process.platform}/${process.arch})`;
    } catch (error) { return `no disponible: ${error instanceof Error ? error.message : String(error)}`; }
  }

  private getRuntime(): PiperNeoRuntime {
    if (!this.runtime) this.runtime = findRuntime();
    return this.runtime;
  }

  private async getHelp(): Promise<string> {
    if (this.help === null) this.help = await readHelp(this.getRuntime());
    return this.help;
  }

  private async logStream(stream: ReadableStream<Uint8Array> | null, label: string): Promise<void> {
    if (!stream) return;
    mkdirSync(this.logsDir, { recursive: true });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text) appendFileSync(join(this.logsDir, "server.log"), `[${new Date().toISOString()}] [${label}] ${text}`);
      }
    } catch { /* el proceso terminó */ }
  }

  private async stopServer(): Promise<void> {
    const child = this.server;
    this.server = null;
    this.serverModelsDir = "";
    this.activeBaseUrl = "";
    if (!child) return;
    try { child.kill(); } catch { /* ya terminado */ }
    await Promise.race([child.exited.catch(() => -1), Bun.sleep(2_000)]);
  }

  async close(): Promise<void> { await this.stopServer(); }

  private configuredBaseUrl(): string | null {
    const external = process.env.PIPER_NEO_BASE_URL?.trim().replace(/\/$/, "");
    return external || null;
  }

  private async probeServer(baseUrl: string, timeoutMs = 20_000, signal?: AbortSignal): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operación cancelada.");
      try {
        const response = await fetch(`${baseUrl}/api/health`, {
          headers: requestHeaders(false),
          signal: abortSignal(signal, 1_500),
        });
        if (response.ok) {
          const payload = await safeJson<PiperApiHealthData>(response);
          if (payload?.success === true && payload.data?.status === "ok") return true;
        }
      } catch (error) {
        if (signal?.aborted) throw error;
      }
      await Bun.sleep(250);
    }
    return false;
  }

  private async ensureServer(request: PiperSynthesisRequest): Promise<string> {
    const external = this.configuredBaseUrl();
    if (external) {
      if (!(await this.probeServer(external, 8_000, request.signal))) {
        throw new Error(`PIPER_NEO_BASE_URL no responde como Piper Neo en ${external}/api/health.`);
      }
      return external;
    }

    const modelsDir = dirname(request.modelPath);
    if (this.server && this.serverModelsDir === modelsDir && this.server.exitCode === null && this.activeBaseUrl) {
      return this.activeBaseUrl;
    }
    await this.stopServer();

    const runtime = this.getRuntime();
    const help = await this.getHelp();
    const serverSpec = serverArgsFromHelp(help, request, this.requestedPort);
    if (!serverSpec) {
      throw new Error("El runtime Piper Neo no expone `--server`. Esta integración requiere la API oficial de Piper Neo.");
    }

    const baseUrl = `http://127.0.0.1:${serverSpec.port}`;
    mkdirSync(this.logsDir, { recursive: true });
    appendFileSync(join(this.logsDir, "server.log"), `\n[${new Date().toISOString()}] START ${runtime.executable} ${serverSpec.args.join(" ")}\n`);
    debugInfo("tts.piper-api", "server_starting", { modelsDir, baseUrl, executable: runtime.executable });

    const child = Bun.spawn([runtime.executable, ...serverSpec.args], {
      cwd: runtime.root,
      env: runtimeEnv(runtime),
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    this.server = child;
    this.serverModelsDir = modelsDir;
    this.activeBaseUrl = baseUrl;
    void this.logStream(child.stdout, "OUT");
    void this.logStream(child.stderr, "ERR");

    if (!(await this.probeServer(baseUrl, 20_000, request.signal))) {
      const code = child.exitCode;
      await this.stopServer();
      throw new Error(`Piper Neo no respondió correctamente en ${baseUrl}/api/health${code !== null ? ` (código ${code})` : ""}. Revisa persistent/piper/logs/server.log.`);
    }
    debugInfo("tts.piper-api", "server_ready", { modelsDir, baseUrl });
    return baseUrl;
  }

  private async synthesizeViaApi(baseUrl: string, request: PiperSynthesisRequest): Promise<Buffer> {
    const model = basename(request.modelPath);
    const payload: Record<string, unknown> = { model, text: request.text };
    if (request.speakerId !== undefined) payload.speaker_id = request.speakerId;

    debugInfo("tts.piper-api", "synthesis_started", { model, textChars: request.text.length, baseUrl });
    const response = await fetch(`${baseUrl}/api/v1/tts`, {
      method: "POST",
      headers: requestHeaders(true),
      body: JSON.stringify(payload),
      signal: abortSignal(request.signal, 120_000),
    });
    const envelope = await safeJson<PiperApiTtsData>(response);
    if (!response.ok || envelope?.success !== true) {
      const code = envelope?.error ? ` ${envelope.error}` : "";
      const message = envelope?.message ? `: ${envelope.message}` : "";
      throw new Error(`Piper Neo POST /api/v1/tts falló con HTTP ${response.status}${code}${message}`);
    }

    const audioPath = envelope.data?.url || (envelope.data?.file ? `/api/v1/files/${encodeURIComponent(envelope.data.file)}` : "");
    if (!audioPath) throw new Error("Piper Neo respondió success=true pero no devolvió data.url ni data.file.");
    const audioUrl = sameOriginFileUrl(baseUrl, audioPath);

    const audioResponse = await fetch(audioUrl, {
      method: "GET",
      headers: {
        ...requestHeaders(false),
        Accept: "audio/wav,application/octet-stream",
      },
      signal: abortSignal(request.signal, 120_000),
    });
    if (!audioResponse.ok) {
      const detail = (await audioResponse.text()).slice(0, 1000);
      throw new Error(`Piper Neo GET ${audioUrl.pathname} falló con HTTP ${audioResponse.status}${detail ? `: ${detail}` : ""}`);
    }
    const audio = Buffer.from(await audioResponse.arrayBuffer());
    if (!isWav(audio)) {
      const type = audioResponse.headers.get("content-type") ?? "desconocido";
      throw new Error(`Piper Neo devolvió un archivo que no es WAV (${audio.length} bytes, content-type ${type}).`);
    }
    debugInfo("tts.piper-api", "synthesis_completed", {
      model,
      bytes: audio.length,
      chunks: envelope.data?.chunks,
      audioSeconds: envelope.data?.audio_seconds,
      inferSeconds: envelope.data?.infer_seconds,
      realTimeFactor: envelope.data?.real_time_factor,
    });
    return audio;
  }

  private async synthesizeCli(request: PiperSynthesisRequest): Promise<Buffer> {
    const runtime = this.getRuntime();
    const help = await this.getHelp();
    const lower = help.toLowerCase();
    if (!lower.includes("--model") || !/--output[_-]file/i.test(help)) {
      throw new Error("El runtime no expone compatibilidad CLI de Piper (--model/--output_file).");
    }
    const dir = join(tmpdir(), `luna-piper-${crypto.randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const output = join(dir, "speech.wav");
    const args = ["--model", request.modelPath];
    if (request.configPath && lower.includes("--config")) args.push("--config", request.configPath);
    args.push("--output_file", output);
    if (request.speakerId !== undefined && lower.includes("--speaker")) args.push("--speaker", String(request.speakerId));
    if (request.lengthScale !== undefined && lower.includes("--length_scale")) args.push("--length_scale", String(request.lengthScale));
    try {
      const child = Bun.spawn([runtime.executable, ...args], {
        cwd: runtime.root,
        env: runtimeEnv(runtime),
        stdin: new Blob([`${request.text}\n`]),
        stdout: "pipe", stderr: "pipe", windowsHide: true,
      });
      const cancel = () => { try { child.kill(); } catch { /* ya terminó */ } };
      request.signal?.addEventListener("abort", cancel, { once: true });
      try {
        const stderr = child.stderr ? new Response(child.stderr).text() : Promise.resolve("");
        const stdout = child.stdout ? new Response(child.stdout).text() : Promise.resolve("");
        const code = await child.exited;
        const [out, err] = await Promise.all([stdout, stderr]);
        if (request.signal?.aborted) throw request.signal.reason instanceof Error ? request.signal.reason : new Error("Síntesis cancelada.");
        if (code !== 0 || !existsSync(output)) throw new Error((err || out || `código ${code}`).trim().slice(-1500));
        const audio = readFileSync(output);
        if (!isWav(audio)) throw new Error("Piper Neo produjo un archivo WAV inválido.");
        return audio;
      } finally { request.signal?.removeEventListener("abort", cancel); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  async synthesize(request: PiperSynthesisRequest): Promise<Buffer> {
    // Piper Neo oficial: servidor HTTP + /api/v1/tts. El fallback CLI queda
    // únicamente para runtimes antiguos/externos que no expongan --server.
    try {
      const baseUrl = await this.ensureServer(request);
      return await this.synthesizeViaApi(baseUrl, request);
    } catch (error) {
      if (this.configuredBaseUrl()) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/no expone `--server`/i.test(message)) throw error;
      debugWarn("tts.piper-api", "server_unavailable_fallback_cli", { error: message });
      return this.synthesizeCli(request);
    }
  }
}
