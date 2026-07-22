import { existsSync, mkdirSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { platform } from "node:os";
import type { WorkspaceManager } from "./workspace-manager.ts";

export type AgenticRuntime = "bash" | "python" | "node" | "bun";

export interface RuntimeState {
  runtime: AgenticRuntime;
  available: boolean;
  executable?: string;
  version?: string;
}

const OUTPUT_LIMIT = 60_000;
const HEAD_LIMIT = 36_000;
const TAIL_LIMIT = 20_000;
const KILL_ESCALATION_MS = 1_200;
let runtimeCache: { at: number; states: RuntimeState[] } | null = null;
let sandboxCache: { at: number; available: boolean; executable?: string; reason?: string } | null = null;

function findExecutable(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 2_000, windowsHide: true });
    if (!result.error && result.status === 0) return candidate;
  }
  return undefined;
}

function versionFor(executable: string): string | undefined {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 2_000, windowsHide: true });
  const raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split(/\r?\n/)[0]?.trim();
  return raw || undefined;
}

export function getRuntimeStatus(force = false): RuntimeState[] {
  if (!force && runtimeCache && Date.now() - runtimeCache.at < 30_000) return runtimeCache.states.map((item) => ({ ...item }));
  const candidates: Array<[AgenticRuntime, string[]]> = platform() === "win32"
    ? [
        ["bash", ["bash.exe", "bash"]],
        ["python", ["python.exe", "python3.exe", "python", "python3"]],
        ["node", ["node.exe", "node"]],
        ["bun", ["bun.exe", "bun"]],
      ]
    : [
        ["bash", ["bash"]],
        ["python", ["python3", "python"]],
        ["node", ["node"]],
        ["bun", ["bun"]],
      ];
  const states = candidates.map(([runtime, names]) => {
    const executable = findExecutable(names);
    return executable
      ? { runtime, available: true, executable, version: versionFor(executable) }
      : { runtime, available: false };
  });
  runtimeCache = { at: Date.now(), states };
  return states.map((item) => ({ ...item }));
}

function getBubblewrapStatus(force = false): { available: boolean; executable?: string; reason?: string } {
  if (platform() !== "linux") return { available: false, reason: `plataforma ${platform()} sin sandbox Linux` };
  if (!force && sandboxCache && Date.now() - sandboxCache.at < 30_000) return { ...sandboxCache };
  const executable = findExecutable(["bwrap"]);
  if (!executable) {
    sandboxCache = { at: Date.now(), available: false, reason: "bubblewrap no instalado" };
    return { ...sandboxCache };
  }
  // El probe usa exactamente las primitivas imprescindibles para el sandbox real:
  // user namespace + PID namespace + mount namespace. Si Docker/host las bloquea,
  // fallamos de forma segura antes de ejecutar código no confiable.
  const probe = spawnSync(executable, [
    "--die-with-parent",
    "--unshare-user",
    "--unshare-pid",
    "--ro-bind", "/", "/",
    "--proc", "/proc",
    "--dev", "/dev",
    "--", "/bin/true",
  ], { encoding: "utf8", timeout: 4_000, windowsHide: true });
  const available = !probe.error && probe.status === 0;
  const reason = available
    ? undefined
    : `${probe.error?.message ?? String(probe.stderr ?? probe.stdout ?? "bubblewrap rechazado por el kernel").trim()}`.slice(0, 600);
  sandboxCache = { at: Date.now(), available, executable, reason };
  return { ...sandboxCache };
}

export function isWorkspaceExecutionAvailable(): boolean {
  if (platform() === "linux") return getBubblewrapStatus().available;
  return process.env.LUNA_ALLOW_UNSANDBOXED_EXEC === "1";
}

export function formatRuntimeStatus(states = getRuntimeStatus()): string {
  const sandbox = getBubblewrapStatus();
  return [
    "Runtimes agenticos:",
    ...states.map((state) => `- ${state.runtime}: ${state.available ? `disponible${state.version ? ` (${state.version})` : ""}` : "no disponible"}`),
    `- sandbox filesystem: ${platform() === "linux" ? (sandbox.available ? "bubblewrap operativo" : `NO operativo${sandbox.reason ? ` (${sandbox.reason})` : ""}`) : (process.env.LUNA_ALLOW_UNSANDBOXED_EXEC === "1" ? "modo no aislado habilitado explícitamente" : "no soportado de forma segura en esta plataforma")}`,
  ].join("\n");
}

class BoundedOutput {
  private head = "";
  private tail = "";
  private truncated = false;

  append(value: string): void {
    if (!value) return;
    const clean = value.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");
    if (!this.truncated) {
      const combined = this.head + clean;
      if (combined.length <= OUTPUT_LIMIT) {
        this.head = combined;
        return;
      }
      this.truncated = true;
      this.head = combined.slice(0, HEAD_LIMIT);
      this.tail = combined.slice(-TAIL_LIMIT);
      return;
    }
    this.tail = (this.tail + clean).slice(-TAIL_LIMIT);
  }

  text(): string {
    return this.truncated
      ? `${this.head}\n\n[...salida truncada; el proceso siguió drenándose...]\n\n${this.tail}`
      : this.head;
  }
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (platform() === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true, timeout: 5_000 });
    return;
  }
  try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
  setTimeout(() => {
    try { process.kill(-child.pid!, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  }, KILL_ESCALATION_MS).unref?.();
}

function addReadOnlyPath(args: string[], source: string, destination = source): void {
  if (!existsSync(source)) return;
  const parent = dirname(destination);
  if (parent !== "/" && !args.some((value, index) => value === "--dir" && args[index + 1] === parent)) {
    // Los directorios principales más comunes se crean explícitamente abajo.
  }
  args.push("--ro-bind", source, destination);
}

function buildBubblewrapArgs(workdir: string, cwdRelative: string, executable: string, runtimeArgs: string[]): string[] {
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--dir", "/etc",
    "--dir", "/workspace",
  ];
  for (const path of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/usr/local"]) addReadOnlyPath(args, path);
  for (const path of [
    "/etc/resolv.conf",
    "/etc/hosts",
    "/etc/nsswitch.conf",
    "/etc/passwd",
    "/etc/group",
    "/etc/ssl/certs",
    "/etc/ca-certificates.conf",
  ]) addReadOnlyPath(args, path);
  args.push(
    "--bind", workdir, "/workspace",
    "--clearenv",
    "--chdir", cwdRelative === "." ? "/workspace" : `/workspace/${cwdRelative.replace(/\\/g, "/")}`,
    "--setenv", "HOME", "/workspace/.home",
    "--setenv", "XDG_CACHE_HOME", "/workspace/.cache",
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "LUNA_WORKDIR", "/workspace",
    "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin",
    executable,
    ...runtimeArgs,
  );
  return args;
}

function runtimeInvocation(runtime: AgenticRuntime, executable: string, code: string, args: string[]): { executable: string; args: string[] } {
  if (runtime === "bash") return { executable, args: ["-lc", code, "luna-script", ...args] };
  if (runtime === "python") return { executable, args: ["-c", code, ...args] };
  if (runtime === "node") return { executable, args: ["-e", code, "--", ...args] };
  return { executable, args: ["-e", code, "--", ...args] };
}

export async function executeSandboxedCode(options: {
  manager: WorkspaceManager;
  jid: string;
  runtime: AgenticRuntime;
  code: string;
  cwd: string;
  args: string[];
  timeoutSeconds: number;
  signal?: AbortSignal;
}): Promise<string> {
  const states = getRuntimeStatus();
  const state = states.find((item) => item.runtime === options.runtime);
  if (!state?.available || !state.executable) {
    return `Error: runtime ${options.runtime} no está disponible en este entorno.\n${formatRuntimeStatus(states)}`;
  }
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("execution-cancelled");

  const workdir = options.manager.getWorkdir(options.jid);
  const cwdAbsolute = options.manager.resolvePath(options.jid, options.cwd, { mustExist: true, allowDirectory: true });
  const cwdRelative = options.manager.relativePath(options.jid, cwdAbsolute) || ".";
  mkdirSync(join(workdir, ".home"), { recursive: true });
  mkdirSync(join(workdir, ".cache"), { recursive: true });

  const invocation = runtimeInvocation(options.runtime, state.executable, options.code, options.args);
  let executable = invocation.executable;
  let childArgs = invocation.args;
  let sandbox = "none";

  if (platform() === "linux") {
    const sandboxStatus = getBubblewrapStatus();
    if (!sandboxStatus.available || !sandboxStatus.executable) {
      return `Error: ejecución de código deshabilitada porque el sandbox bubblewrap no está operativo. Luna no ejecutará terminal sin aislamiento de filesystem.${sandboxStatus.reason ? ` Motivo: ${sandboxStatus.reason}` : ""}`;
    }
    executable = sandboxStatus.executable;
    childArgs = buildBubblewrapArgs(workdir, cwdRelative, invocation.executable, invocation.args);
    sandbox = "bubblewrap";
  } else if (process.env.LUNA_ALLOW_UNSANDBOXED_EXEC !== "1") {
    return `Error: ejecución agentica deshabilitada en ${platform()} porque no hay un sandbox de filesystem equivalente configurado. Para evitar que un script salga del workdir, Luna falla de forma segura. LUNA_ALLOW_UNSANDBOXED_EXEC=1 habilita un modo explícitamente no aislado bajo responsabilidad del operador.`;
  }

  const stdout = new BoundedOutput();
  const stderr = new BoundedOutput();
  const startedAt = Date.now();

  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(executable, childArgs, {
      cwd: platform() === "linux" && sandbox === "bubblewrap" ? undefined : cwdAbsolute,
      env: platform() === "linux" && sandbox === "bubblewrap"
        ? { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" }
        : {
            PATH: process.env.PATH,
            HOME: join(workdir, ".home"),
            XDG_CACHE_HOME: join(workdir, ".cache"),
            TMPDIR: join(workdir, ".cache"),
            LUNA_WORKDIR: workdir,
          },
      stdio: ["ignore", "pipe", "pipe"],
      detached: platform() !== "win32",
      windowsHide: true,
    });

    const finish = (value: string, error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => {
      killTree(child);
      finish("", options.signal?.reason ?? new Error("execution-cancelled"));
    };
    timer = setTimeout(() => {
      killTree(child);
      finish([
        `Error: ejecución excedió ${options.timeoutSeconds}s y fue terminada.`,
        `Runtime: ${options.runtime}`,
        `Sandbox: ${sandbox}`,
        stdout.text() ? `STDOUT:\n${stdout.text()}` : "",
        stderr.text() ? `STDERR:\n${stderr.text()}` : "",
      ].filter(Boolean).join("\n\n"));
    }, options.timeoutSeconds * 1000);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    child.stdout?.on("data", (chunk: Buffer | string) => stdout.append(String(chunk)));
    child.stderr?.on("data", (chunk: Buffer | string) => stderr.append(String(chunk)));
    child.on("error", (error) => finish(`Error: no se pudo iniciar ${options.runtime}: ${error.message}`));
    child.on("close", (code, signalName) => {
      const durationMs = Date.now() - startedAt;
      finish([
        `Runtime: ${options.runtime}`,
        `Sandbox: ${sandbox}`,
        `Exit code: ${code ?? "null"}${signalName ? ` (${signalName})` : ""}`,
        `Duración: ${durationMs} ms`,
        stdout.text() ? `STDOUT:\n${stdout.text()}` : "STDOUT: (vacío)",
        stderr.text() ? `STDERR:\n${stderr.text()}` : "STDERR: (vacío)",
      ].join("\n\n"));
    });
  });
}
