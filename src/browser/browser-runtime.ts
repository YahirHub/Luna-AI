import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAppDir } from "../utils.ts";
import {
  agentBrowserGenericName,
  agentBrowserNativeName,
  resolveManagedAgentBrowserChrome,
  resolveSystemBrowserExecutable,
  supportsManagedAgentBrowserChrome,
} from "./browser-discovery.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import type { BrowserCredentialStore, BrowserInputKind } from "./browser-credentials.ts";
import { debugInfo, debugLog, debugWarn } from "../debug.ts";
import { createProcessOutputCollector } from "./process-output.ts";
import { loadOrCreateBrowserEncryptionKey } from "./browser-encryption.ts";
import { writeJsonFileAtomically } from "../storage.ts";

export function resolveAgentBrowserBinary(): string {
  const appDir = getAppDir();
  const nativeName = agentBrowserNativeName();
  const genericName = agentBrowserGenericName();
  const candidates = [
    join(appDir, "runtime", "agent-browser", genericName),
    join(appDir, "runtime", "agent-browser", nativeName),
    join(process.cwd(), "dist", "runtime", "agent-browser", genericName),
    join(process.cwd(), "assets", "runtime", "agent-browser", genericName),
    join(process.cwd(), "assets", "runtime", "agent-browser", nativeName),
    join(process.cwd(), "dist", "runtime", "agent-browser", nativeName),
    join(process.cwd(), "node_modules", "agent-browser", "bin", nativeName),
    join(appDir, "node_modules", "agent-browser", "bin", nativeName),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "No se encontró el runtime nativo de agent-browser. Ejecuta bun install o bun run prepare:browser antes de iniciar Luna.",
  );
}

function encryptionKey(): string {
  return loadOrCreateBrowserEncryptionKey(join(getAppDir(), "persistent", "browser", "encryption.key"));
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "file";
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

export interface BrowserExecutionOptions {
  jid: string;
  runId: string;
  taskId: string;
  agentId: string;
  agentName: string;
  agentDir: string;
  workspace: WorkspaceManager;
  credentials: BrowserCredentialStore;
  /** Texto original del usuario que debe reanudarse si el subagente necesita un dato humano. */
  resumePrompt?: string;
  /** Canal de sistema para pedir datos sin hacer que el LLM formule o reciba secretos. */
  onUserInputRequest?: (request: {
    kind: BrowserInputKind;
    fieldName: string;
    url?: string;
    username?: string;
    message?: string;
    requestId: string;
    screenshotPath?: string;
  }) => void | Promise<void>;
  /** Notifica al supervisor cuando el navegador espera un recurso, al usuario o reanuda. */
  onStateChange?: (state: "queued" | "running" | "waiting_user") => void | Promise<void>;
}

class BrowserCommandTimeoutError extends Error {
  constructor(
    readonly command: string,
    readonly timeoutMs: number,
  ) {
    super(`agent-browser no respondió al comando ${command} después de ${Math.round(timeoutMs / 1000)} segundos.`);
    this.name = "BrowserCommandTimeoutError";
  }
}

const BROWSER_COMMAND_TIMEOUT_MS = {
  open: 45_000,
  inspect: 20_000,
  action: 30_000,
  screenshot: 45_000,
  download: 120_000,
  auth: 120_000,
  close: 15_000,
} as const;

function extractCurrentUrl(output: string): string | undefined {
  try {
    const parsed = JSON.parse(output) as { data?: unknown };
    if (typeof parsed.data === "string" && /^https?:\/\//i.test(parsed.data)) return parsed.data;
    if (parsed.data && typeof parsed.data === "object") {
      const url = (parsed.data as Record<string, unknown>).url;
      if (typeof url === "string" && /^https?:\/\//i.test(url)) return url;
    }
  } catch {
    // Algunos comandos/versiones imprimen texto plano aunque se solicite JSON.
  }
  return output.match(/https?:\/\/[^\s"}]+/i)?.[0];
}


interface BrowserStorageCookie extends Record<string, unknown> {
  name?: unknown;
  domain?: unknown;
  path?: unknown;
  partitionKey?: unknown;
}

interface BrowserStorageOrigin extends Record<string, unknown> {
  origin?: unknown;
  localStorage?: unknown;
}

interface BrowserStorageState extends Record<string, unknown> {
  cookies?: unknown;
  origins?: unknown;
}

function stableStorageKey(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object") return `${fallback}:${JSON.stringify(value)}`;
  return JSON.stringify(value);
}

/**
 * Combina estados Playwright/agent-browser producidos por ejecuciones paralelas.
 * El estado más reciente gana para la misma cookie/origen, pero no elimina las
 * sesiones de otros sitios que haya guardado otro agente concurrente.
 */
export function mergeBrowserStorageStates(baseValue: unknown, incomingValue: unknown): BrowserStorageState {
  const base = baseValue && typeof baseValue === "object" && !Array.isArray(baseValue)
    ? baseValue as BrowserStorageState
    : {};
  const incoming = incomingValue && typeof incomingValue === "object" && !Array.isArray(incomingValue)
    ? incomingValue as BrowserStorageState
    : {};

  const cookieMap = new Map<string, unknown>();
  const addCookies = (items: unknown): void => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const cookie = item && typeof item === "object" ? item as BrowserStorageCookie : undefined;
      const key = cookie
        ? `${String(cookie.name ?? "")}|${String(cookie.domain ?? "")}|${String(cookie.path ?? "")}|${String(cookie.partitionKey ?? "")}`
        : stableStorageKey(item, "cookie");
      cookieMap.set(key, item);
    }
  };
  addCookies(base.cookies);
  addCookies(incoming.cookies);

  const originMap = new Map<string, BrowserStorageOrigin>();
  const addOrigins = (items: unknown): void => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const origin = item as BrowserStorageOrigin;
      const key = typeof origin.origin === "string" && origin.origin
        ? origin.origin
        : stableStorageKey(origin, "origin");
      const previous = originMap.get(key);
      const localStorage = new Map<string, unknown>();
      const addLocal = (entries: unknown): void => {
        if (!Array.isArray(entries)) return;
        for (const entry of entries) {
          const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : undefined;
          const entryKey = record && typeof record.name === "string"
            ? record.name
            : stableStorageKey(entry, "local");
          localStorage.set(entryKey, entry);
        }
      };
      addLocal(previous?.localStorage);
      addLocal(origin.localStorage);
      originMap.set(key, {
        ...(previous ?? {}),
        ...origin,
        ...(localStorage.size > 0 ? { localStorage: [...localStorage.values()] } : {}),
      });
    }
  };
  addOrigins(base.origins);
  addOrigins(incoming.origins);

  return {
    ...base,
    ...incoming,
    cookies: [...cookieMap.values()],
    origins: [...originMap.values()],
  };
}

const browserProfileQueues = new Map<string, Promise<void>>();

/**
 * Lease FIFO cancelable para operaciones persistentes breves. Actualmente se
 * usa únicamente al fusionar el estado autenticado de navegadores concurrentes;
 * la navegación y los perfiles físicos ya no se serializan.
 */
export async function acquireBrowserProfileLease(key: string, signal?: AbortSignal): Promise<() => void> {
  const previous = browserProfileQueues.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => { releaseCurrent = resolve; });
  const tail = previous.then(() => current);
  browserProfileQueues.set(key, tail);

  let abortHandler: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return;
    abortHandler = () => reject(signal.reason ?? new Error("browser-profile-lease-cancelled"));
    if (signal.aborted) abortHandler();
    else signal.addEventListener("abort", abortHandler, { once: true });
  });

  try {
    await (signal ? Promise.race([previous, aborted]) : previous);
  } catch (error) {
    // Nuestra entrada ya fue añadida a la cola. Aunque el consumidor haya sido
    // cancelado, debemos resolverla cuando llegue su turno para que el siguiente
    // agente no quede esperando una promesa que nadie liberará.
    void previous.finally(() => {
      releaseCurrent();
      if (browserProfileQueues.get(key) === tail) browserProfileQueues.delete(key);
    });
    throw error;
  } finally {
    if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseCurrent();
    if (browserProfileQueues.get(key) === tail) browserProfileQueues.delete(key);
  };
}

export class BrowserAgentExecution {
  private readonly sessionBase: string;
  private session: string;
  private readonly restoreName: string;
  private readonly binary: string;
  private readonly runtimeCwd: string;
  private readonly runRuntimeDir: string;
  private readonly persistentHome: string;
  private readonly profileDir: string;
  private readonly stateFile: string;
  private readonly runStateFile: string;
  private readonly profileLeaseKey: string;
  private releaseProfileLease?: () => void;
  private recoveryCounter = 0;
  private screenshotCounter = 0;
  private downloadCounter = 0;
  private snapshotCounter = 0;
  private readCounter = 0;
  private inputRequestCounter = 0;
  private readonly activeChildren = new Set<any>();
  private commandTail: Promise<void> = Promise.resolve();
  private keepAliveTimer?: ReturnType<typeof setInterval>;
  private keepAliveController?: AbortController;
  private finalizePromise?: Promise<void>;
  private sessionTouched = false;
  private cancelled = false;
  private finalizing = false;

  constructor(private readonly options: BrowserExecutionOptions) {
    const id = stableHash(`${options.jid}:${options.runId}`);
    const userState = stableHash(options.jid);
    this.sessionBase = `luna-${id}`;
    this.session = this.sessionBase;
    this.restoreName = this.sessionBase;
    this.binary = resolveAgentBrowserBinary();
    this.runRuntimeDir = join(getAppDir(), "persistent", "browser", "runs", safeName(options.runId));
    this.runtimeCwd = this.runRuntimeDir;
    // Cada agente obtiene HOME y perfil propios. Compartir el directorio físico de
    // Chrome impedía la concurrencia real y hacía que un agente esperando datos
    // bloqueara a todos los demás. El estado autenticado portable se comparte
    // mediante stateFile y solo su escritura final se serializa.
    this.persistentHome = join(this.runRuntimeDir, "home");
    this.profileDir = join(this.runRuntimeDir, "profile");
    this.stateFile = join(getAppDir(), "persistent", "browser", "users", userState, "session-state.json");
    this.runStateFile = join(this.runRuntimeDir, "session-state-export.json");
    this.profileLeaseKey = `${userState}:state-save`;
    mkdirSync(this.runtimeCwd, { recursive: true });
    mkdirSync(this.persistentHome, { recursive: true });
    mkdirSync(this.profileDir, { recursive: true });
    mkdirSync(dirname(this.stateFile), { recursive: true });
  }

  private logContext(action: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      backend: "browser-agent",
      taskId: this.options.taskId,
      agentId: this.options.agentId,
      agentName: this.options.agentName,
      agentType: "browser-web",
      runId: this.options.runId,
      action,
      ...extra,
    };
  }

  private env(): Record<string, string> {
    // Prioridad: ruta explícita del operador > Chrome for Testing administrado
    // por agent-browser > navegador del sistema. Esto evita forzar Chrome/Edge
    // del usuario cuando ya existe el runtime probado que instala `agent-browser install`.
    const explicitBrowser = process.env.AGENT_BROWSER_EXECUTABLE_PATH?.trim();
    const managedBrowser = supportsManagedAgentBrowserChrome()
      ? resolveManagedAgentBrowserChrome()
      : undefined;
    const browserExecutable = explicitBrowser && existsSync(explicitBrowser)
      ? explicitBrowser
      : managedBrowser ?? resolveSystemBrowserExecutable();
    return {
      ...process.env,
      AGENT_BROWSER_SESSION: this.session,
      // El nombre pertenece únicamente a esta ejecución. La persistencia real
      // entre ejecuciones se restaura desde AGENT_BROWSER_STATE.
      AGENT_BROWSER_SESSION_NAME: this.restoreName,
      // Un namespace por ejecución evita compartir el daemon persistente entre tareas.
      // Así close --all e idle-timeout solo afectan a este agente.
      AGENT_BROWSER_NAMESPACE: `luna-run-${stableHash(`${this.options.jid}:${this.options.runId}`)}`,
      // Perfil físico aislado para permitir varios browser-web en paralelo.
      AGENT_BROWSER_PROFILE: this.profileDir,
      ...(existsSync(this.stateFile) ? { AGENT_BROWSER_STATE: this.stateFile } : {}),
      AGENT_BROWSER_CONTENT_BOUNDARIES: "true",
      AGENT_BROWSER_MAX_OUTPUT: "50000",
      // Debe quedar por debajo del timeout IPC del CLI (30 s). Así el daemon
      // devuelve un error controlado antes de que el cliente quede esperando.
      AGENT_BROWSER_DEFAULT_TIMEOUT: process.env.AGENT_BROWSER_DEFAULT_TIMEOUT?.trim() || "20000",
      // El daemon pertenece exclusivamente a esta ejecución. Un keepalive interno
      // evita que expire mientras el agente sigue razonando o espera datos del usuario;
      // al finalizar dejamos de enviar keepalives y el daemon aislado se apaga solo.
      AGENT_BROWSER_IDLE_TIMEOUT_MS: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS?.trim() || "10000",
      AGENT_BROWSER_ENCRYPTION_KEY: encryptionKey(),
      // El HOME temporal evita que daemons/sesiones concurrentes se pisen. Se
      // elimina al terminar; cookies/localStorage duraderos viven en stateFile.
      HOME: this.persistentHome,
      USERPROFILE: this.persistentHome,
      XDG_CACHE_HOME: join(this.persistentHome, ".cache"),
      XDG_CONFIG_HOME: join(this.persistentHome, ".config"),
      XDG_STATE_HOME: join(this.persistentHome, ".local", "state"),
      ...(browserExecutable ? { AGENT_BROWSER_EXECUTABLE_PATH: browserExecutable } : {}),
    } as Record<string, string>;
  }

  private async withCommandLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.commandTail;
    let release!: () => void;
    this.commandTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async run(
    args: string[],
    signal: AbortSignal,
    stdinText?: string,
    timeoutMs: number = BROWSER_COMMAND_TIMEOUT_MS.action,
  ): Promise<string> {
    if (signal.aborted) throw signal.reason ?? new Error("browser-cancelled");
    return await this.withCommandLock(async () => {
      if (signal.aborted) throw signal.reason ?? new Error("browser-cancelled");
      if (!["state", "close", "doctor"].includes(args[0] ?? "")) this.sessionTouched = true;

      const command = args.slice(0, 2).join(" ") || "unknown";
    const startedAt = Date.now();
    const env = this.env();
    debugLog("browser-agent.runtime", "command_started", this.logContext(`Ejecutando agent-browser: ${command}`, {
      session: this.session, command, timeoutMs, executablePath: env.AGENT_BROWSER_EXECUTABLE_PATH ?? "managed-default",
    }));

    const child = Bun.spawn([
      this.binary,
      "--session", this.session,
      "--session-name", this.restoreName,
      "--content-boundaries",
      "--max-output", "50000",
      ...args,
    ], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: stdinText === undefined ? "ignore" : "pipe",
      cwd: this.runtimeCwd,
      env,
    });

    this.activeChildren.add(child);
    void child.exited.finally(() => this.activeChildren.delete(child));

    let timedOut = false;
    const onAbort = () => {
      try { child.kill(); } catch { /* already exited */ }
    };
    signal.addEventListener("abort", onAbort, { once: true });

    // Importante: no usamos `new Response(child.stdout).text()`. agent-browser
    // levanta un daemon persistente y, especialmente en Windows, ese daemon puede
    // heredar los handles de los pipes. El CLI puede haber terminado mientras el
    // pipe sigue abierto, lo que dejaría a Luna esperando EOF indefinidamente.
    const stdoutCollector = createProcessOutputCollector(child.stdout);
    const stderrCollector = createProcessOutputCollector(child.stderr);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    try {
      if (stdinText !== undefined && child.stdin) {
        child.stdin.write(`${stdinText}\n`);
        child.stdin.end();
      }

      const outcome = await Promise.race([
        child.exited.then((exitCode: number) => ({ kind: "exit" as const, exitCode })),
        new Promise<{ kind: "timeout" }>((resolve) => {
          timeoutHandle = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
        }),
      ]);

      if (outcome.kind === "timeout") {
        timedOut = true;
        debugWarn("browser-agent.runtime", "command_timeout", this.logContext(`Tiempo agotado en agent-browser: ${command}`, {
          session: this.session, command, timeoutMs, durationMs: Date.now() - startedAt,
        }));
        try { child.kill(); } catch { /* best effort */ }
        // No dejamos que un proceso CLI bloqueado congele el subagente completo.
        await Promise.race([
          child.exited.catch(() => -1),
          new Promise<number>((resolve) => setTimeout(() => resolve(-1), 2_000)),
        ]);
        throw new BrowserCommandTimeoutError(command, timeoutMs);
      }

      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (signal.aborted) throw signal.reason ?? new Error("browser-cancelled");

      // Damos una ventana muy corta para drenar los últimos bytes escritos por el
      // CLI. Después cancelamos nuestras lecturas aunque el daemon haya heredado
      // los handles y mantenga los pipes abiertos.
      await new Promise((resolve) => setTimeout(resolve, 120));
      const stdoutWasOpen = !stdoutCollector.closed();
      const stderrWasOpen = !stderrCollector.closed();
      stdoutCollector.stop();
      stderrCollector.stop();
      await Promise.race([
        Promise.allSettled([stdoutCollector.done, stderrCollector.done]),
        new Promise((resolve) => setTimeout(resolve, 250)),
      ]);

      const stdout = stdoutCollector.text();
      const stderr = stderrCollector.text();
      if (stdoutWasOpen || stderrWasOpen) {
        debugLog("browser-agent.runtime", "pipe_detached_after_cli_exit", this.logContext(`Liberando streams de agent-browser: ${command}`, {
          session: this.session, command, stdoutWasOpen, stderrWasOpen,
        }));
      }

      if (outcome.exitCode !== 0) {
        throw new Error((stderr || stdout || `agent-browser terminó con código ${outcome.exitCode}`).trim());
      }

      debugInfo("browser-agent.runtime", "command_completed", this.logContext(`Comando agent-browser completado: ${command}`, {
        session: this.session, command, durationMs: Date.now() - startedAt, outputChars: (stdout || stderr).length,
      }));
      return stdout.trim() || stderr.trim() || "OK";
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      signal.removeEventListener("abort", onAbort);
      // Siempre soltamos los lectores. Esto también cubre abortos y errores antes
      // de que el CLI alcance una salida normal.
      stdoutCollector.stop();
      stderrCollector.stop();
      if (timedOut) {
        void stdoutCollector.done;
        void stderrCollector.done;
      }
    }
    });
  }

  private startKeepAlive(): void {
    if (this.keepAliveTimer || this.finalizing || this.cancelled) return;
    const controller = new AbortController();
    this.keepAliveController = controller;
    this.keepAliveTimer = setInterval(() => {
      if (this.finalizing || this.cancelled || controller.signal.aborted) return;
      void this.run(["get", "url", "--json"], controller.signal, undefined, 5_000).catch(() => undefined);
    }, 4_000);
    this.keepAliveTimer.unref?.();
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = undefined;
    this.keepAliveController?.abort(new Error("browser-keepalive-stopped"));
    this.keepAliveController = undefined;
  }

  private rotateSessionAfterHang(): void {
    this.recoveryCounter += 1;
    this.session = `${this.sessionBase}-recovery-${this.recoveryCounter}`;
    debugWarn("browser-agent.runtime", "session_rotated", this.logContext("Rotando sesión bloqueada de agent-browser", {
      session: this.session, recoveryCounter: this.recoveryCounter,
    }));
  }


  private async appendInitialSnapshot(opened: string, signal: AbortSignal): Promise<string> {
    try {
      const snapshot = await this.run(["snapshot", "-i", "-c", "-d", "4", "--json"], signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.inspect);
      this.snapshotCounter += 1;
      const path = `${this.options.agentDir}/browser/snapshots/${String(this.snapshotCounter).padStart(3, "0")}-initial.json`;
      this.options.workspace.writeText(this.options.jid, path, `${snapshot}
`);
      return `${opened}

[SISTEMA: browser_open ya incluyó el snapshot interactivo inicial. No llames browser_snapshot otra vez hasta que la página cambie.]
${snapshot}

[SISTEMA: snapshot físico guardado en ${path}]`;
    } catch (error) {
      debugWarn("browser-agent.runtime", "initial_snapshot_failed", this.logContext("No se pudo obtener el snapshot inicial", {
        error: error instanceof Error ? error.message : String(error),
      }));
      return opened;
    }
  }

  private async openWithRecovery(url: string, signal: AbortSignal): Promise<string> {
    try {
      const opened = await this.run(["open", url, "--json"], signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.open);
      this.startKeepAlive();
      return await this.appendInitialSnapshot(opened, signal);
    } catch (error) {
      if (!(error instanceof BrowserCommandTimeoutError) || signal.aborted) throw error;

      // A veces la navegación terminó pero el CLI no devolvió control. Primero
      // comprobamos la URL de la sesión antes de reiniciarla.
      try {
        const currentOutput = await this.run(["get", "url", "--json"], signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.inspect);
        const currentUrl = extractCurrentUrl(currentOutput);
        if (currentUrl) {
          debugWarn("browser-agent.runtime", "open_recovered_from_current_url", this.logContext("La página abrió aunque el CLI agotó el tiempo", {
            requestedUrl: url, currentUrl,
          }));
          this.startKeepAlive();
          return await this.appendInitialSnapshot(JSON.stringify({
            success: true,
            data: { url: currentUrl, recoveredFromOpenTimeout: true },
          }), signal);
        }
      } catch {
        // Continuamos con una sesión limpia.
      }

      // Si la sesión quedó trabada en el daemon, una sesión nueva evita esperar
      // hasta el timeout global de 20 minutos del subagente.
      this.rotateSessionAfterHang();
      debugWarn("browser-agent.runtime", "open_retry", this.logContext("Reintentando apertura con una sesión nueva", {
        url, session: this.session,
      }));
      const reopened = await this.run(["open", url, "--json"], signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.open);
      this.startKeepAlive();
      return await this.appendInitialSnapshot(reopened, signal);
    }
  }

  private resolveArtifact(kind: "screenshots" | "downloads", requested: string, fallback: string): { absolute: string; relative: string } {
    const name = safeName(basename(requested || fallback));
    const rel = `${this.options.agentDir}/browser/${kind}/${name}`.replace(/\\/g, "/");
    const absolute = this.options.workspace.resolvePath(this.options.jid, rel);
    mkdirSync(dirname(absolute), { recursive: true });
    return { absolute, relative: rel };
  }


  private async captureInputRequestScreenshot(signal: AbortSignal): Promise<string | undefined> {
    this.inputRequestCounter += 1;
    const file = this.resolveArtifact(
      "screenshots",
      `input-request-${String(this.inputRequestCounter).padStart(3, "0")}.png`,
      `input-request-${this.inputRequestCounter}.png`,
    );
    try {
      await this.run(["screenshot", file.absolute, "--annotate"], signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.screenshot);
      this.options.workspace.registerArtifact(this.options.jid, file.relative, "browser-web-input", {
        taskId: this.options.taskId,
        temporary: false,
      });
      return file.relative;
    } catch (error) {
      debugWarn("browser-agent.runtime", "input_request_screenshot_failed", this.logContext("No se pudo capturar el formulario antes de pedir datos", {
        error: error instanceof Error ? error.message : String(error),
      }));
      return undefined;
    }
  }

  private async terminateActiveProcesses(): Promise<void> {
    for (const child of [...this.activeChildren]) {
      try { child.kill("SIGTERM"); } catch { /* proceso ya cerrado */ }
    }
    await Promise.race([
      Promise.allSettled([...this.activeChildren].map((child) => child.exited.catch(() => -1))),
      new Promise((resolve) => setTimeout(resolve, 1_500)),
    ]);
    for (const child of [...this.activeChildren]) {
      try { child.kill("SIGKILL"); } catch { /* best effort */ }
    }
  }

  /** Interrumpe inmediatamente comandos CLI activos y cierra el navegador de esta ejecución. */
  async cancel(reason = new Error("browser-agent-cancelled")): Promise<void> {
    this.cancelled = true;
    this.stopKeepAlive();
    await this.terminateActiveProcesses();
    debugWarn("browser-agent.runtime", "execution_cancelled", this.logContext("Cancelando navegador y procesos asociados", {
      session: this.session, reason: reason.message,
    }));
    // No esperamos a que el runner/LLM reaccione al AbortSignal para liberar el
    // navegador: la cancelación del supervisor debe cerrar recursos de inmediato.
    await this.finalize();
  }

  /**
   * Persiste el estado autenticado y cierra únicamente la instancia de esta
   * ejecución. Es idempotente: cancelación, error y finally pueden invocarla a
   * la vez sin lanzar dos secuencias de cierre sobre el mismo daemon.
   */
  async finalize(): Promise<void> {
    if (this.finalizePromise) return await this.finalizePromise;
    this.finalizing = true;
    this.stopKeepAlive();
    this.finalizePromise = this.finalizeInternal();
    return await this.finalizePromise;
  }

  private mergePersistentState(): void {
    const incoming = JSON.parse(readFileSync(this.runStateFile, "utf8")) as unknown;
    let base: unknown = {};
    if (existsSync(this.stateFile)) {
      try { base = JSON.parse(readFileSync(this.stateFile, "utf8")) as unknown; } catch { base = {}; }
    }
    writeJsonFileAtomically(this.stateFile, mergeBrowserStorageStates(base, incoming));
  }

  private async finalizeInternal(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("browser-finalize-timeout")), 20_000);
    try {
      if (this.sessionTouched) {
        // Durante una cancelación priorizamos liberar el navegador/perfil cuanto
        // antes. agent-browser ya persiste automáticamente la sesión nombrada;
        // intentar state save tras matar el CLI podía consumir ~15 s adicionales
        // con un daemon ya inaccesible y mantener bloqueados agentes en cola.
        if (!this.cancelled) {
          try {
            await this.run(["state", "save", this.runStateFile, "--json"], controller.signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.close);
            this.releaseProfileLease = await acquireBrowserProfileLease(this.profileLeaseKey, controller.signal);
            this.mergePersistentState();
            debugInfo("browser-agent.runtime", "persistent_state_saved", this.logContext("Estado autenticado del navegador guardado", {
              session: this.session, stateFile: this.stateFile, strategy: "merge",
            }));
          } catch (error) {
            debugWarn("browser-agent.runtime", "persistent_state_save_failed", this.logContext("No se pudo guardar el estado autenticado", {
              session: this.session, error: error instanceof Error ? error.message : String(error),
            }));
          } finally {
            this.releaseProfileLease?.();
            this.releaseProfileLease = undefined;
          }
        }

        try {
          await this.run(["close"], controller.signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.close);
        } catch {
          // Best effort: una sesión ya cerrada no debe convertir una tarea exitosa
          // en fallida. El state save anterior es lo importante.
        }
        try {
          // El namespace es exclusivo del run, por lo que close --all no toca
          // navegadores de otros agentes ni procesos manuales del operador.
          await this.run(["close", "--all"], controller.signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.close);
        } catch {
          /* best effort */
        }
      }
      await this.terminateActiveProcesses();
    } finally {
      clearTimeout(timer);
      this.releaseProfileLease?.();
      this.releaseProfileLease = undefined;
      try { rmSync(this.runRuntimeDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  async executeTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    if (this.cancelled || this.finalizing) throw new Error("browser-agent-cancelled");
    switch (name) {
      case "browser_open": {
        const url = typeof args.url === "string" ? args.url.trim() : "";
        if (!url) return "Error: url es obligatoria.";
        return await this.openWithRecovery(url, signal);
      }
      case "browser_snapshot": {
        const cmd = ["snapshot"];
        if (args.interactive !== false) cmd.push("-i");
        if (args.compact !== false) cmd.push("-c");
        if (Number.isInteger(args.depth)) cmd.push("-d", String(args.depth));
        cmd.push("--json");
        const output = await this.run(cmd, signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.inspect);
        this.snapshotCounter += 1;
        const path = `${this.options.agentDir}/browser/snapshots/${String(this.snapshotCounter).padStart(3, "0")}-snapshot.json`;
        this.options.workspace.writeText(this.options.jid, path, `${output}\n`);
        return `${output}\n\n[SISTEMA: snapshot físico guardado en ${path}]`;
      }
      case "browser_read": {
        const output = await this.run(["get", "text", "body", "--json"], signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.inspect);
        this.readCounter += 1;
        const path = `${this.options.agentDir}/browser/extracted/${String(this.readCounter).padStart(3, "0")}-page.txt`;
        this.options.workspace.writeText(this.options.jid, path, `${output}\n`);
        return `${output}\n\n[SISTEMA: contenido extraído guardado en ${path}]`;
      }
      case "browser_click":
        return await this.run(["click", String(args.selector ?? "")], signal);
      case "browser_fill":
        return await this.run(["fill", String(args.selector ?? ""), String(args.text ?? "")], signal);
      case "browser_type":
        return await this.run(["type", String(args.selector ?? ""), String(args.text ?? "")], signal);
      case "browser_press":
        return await this.run(["press", String(args.key ?? "")], signal);
      case "browser_wait": {
        if (Number.isInteger(args.milliseconds)) return await this.run(["wait", String(args.milliseconds)], signal);
        if (typeof args.text === "string" && args.text) return await this.run(["wait", "--text", args.text], signal);
        if (typeof args.url === "string" && args.url) return await this.run(["wait", "--url", args.url], signal);
        if (typeof args.load === "string" && args.load) return await this.run(["wait", "--load", args.load], signal);
        if (typeof args.selector === "string" && args.selector) return await this.run(["wait", args.selector], signal);
        return "Error: browser_wait requiere milliseconds, text, url, load o selector.";
      }
      case "browser_get_text":
        return await this.run(["get", "text", String(args.selector ?? ""), "--json"], signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.inspect);
      case "browser_get_url":
        return await this.run(["get", "url", "--json"], signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.inspect);
      case "browser_screenshot": {
        this.screenshotCounter += 1;
        const requested = typeof args.filename === "string" ? args.filename : "";
        const fallback = `screenshot-${String(this.screenshotCounter).padStart(3, "0")}.png`;
        const file = this.resolveArtifact("screenshots", requested, fallback);
        const cmd = ["screenshot", file.absolute];
        if (args.full === true) cmd.push("--full");
        if (args.annotate === true) cmd.push("--annotate");
        await this.run(cmd, signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.screenshot);
        this.options.workspace.registerArtifact(this.options.jid, file.relative, "browser-web", { taskId: this.options.taskId, temporary: false });
        return JSON.stringify({ ok: true, path: file.relative, kind: "screenshot" });
      }
      case "browser_download": {
        this.downloadCounter += 1;
        const selector = typeof args.selector === "string" ? args.selector.trim() : "";
        if (!selector) return "Error: selector es obligatorio.";
        const requested = typeof args.filename === "string" ? args.filename : "";
        const fallback = `download-${String(this.downloadCounter).padStart(3, "0")}.bin`;
        const file = this.resolveArtifact("downloads", requested, fallback);
        await this.run(["download", selector, file.absolute], signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.download);
        this.options.workspace.registerArtifact(this.options.jid, file.relative, "browser-web", { taskId: this.options.taskId, temporary: false });
        return JSON.stringify({ ok: true, path: file.relative, kind: "download" });
      }
      case "browser_auth_profiles": {
        const url = typeof args.url === "string" ? args.url.trim() : "";
        const username = typeof args.username === "string" ? args.username.trim() : "";
        const profiles = this.options.credentials.listProfiles(this.options.jid, url || undefined, username || undefined);
        return JSON.stringify({
          profiles: profiles.map((profile) => ({
            credential_ref: profile.ref,
            url: profile.url,
            origin: profile.origin,
            username: profile.username,
            label: profile.label,
            last_used_at: profile.lastUsedAt,
          })),
          note: profiles.length === 0
            ? "No hay credenciales guardadas que coincidan. Solicita el dato faltante con browser_request_user_input."
            : "Estas referencias son seguras y no contienen contraseñas.",
        }, null, 2);
      }
      case "browser_request_user_input": {
        const kindRaw = typeof args.kind === "string" ? args.kind : "text";
        const kind: BrowserInputKind = ["username", "password", "otp", "text"].includes(kindRaw)
          ? kindRaw as BrowserInputKind
          : "text";
        const fieldName = typeof args.field_name === "string" ? args.field_name.trim() : "";
        const url = typeof args.url === "string" ? args.url.trim() : "";
        const username = typeof args.username === "string" ? args.username.trim() : "";
        const message = typeof args.message === "string" ? args.message.trim() : "";
        if (!fieldName) return "Error: field_name es obligatorio.";
        if (kind === "password" && (!url || !username)) {
          return "Error: para solicitar una contraseña debes indicar url y username. Si falta o quieres confirmar el usuario, solicítalo primero con kind=username.";
        }

        const requestId = `browser-input-${crypto.randomUUID()}`;
        const screenshotPath = await this.captureInputRequestScreenshot(signal);

        // Registrar la espera ANTES de emitir el mensaje evita una carrera si el
        // usuario responde inmediatamente. Cada agente conserva su requestId para
        // soportar varias solicitudes simultáneas dentro del mismo chat.
        await this.options.onStateChange?.("waiting_user");
        const pending = this.options.credentials.waitForInput({
          jid: this.options.jid,
          kind,
          fieldName,
          originalText: this.options.resumePrompt || `Continúa la misión de navegador: ${message || fieldName}`,
          url: url || undefined,
          username: username || undefined,
          message: message || undefined,
          requestId,
          taskId: this.options.taskId,
          agentId: this.options.agentId,
          agentName: this.options.agentName,
          screenshotPath,
        }, signal);

        try {
          await this.options.onUserInputRequest?.({
            kind,
            fieldName,
            url: url || undefined,
            username: username || undefined,
            message: message || undefined,
            requestId,
            screenshotPath,
          });
        } catch (error) {
          this.options.credentials.cancelPendingInput(this.options.jid, error, requestId);
          throw error;
        }

        debugInfo("browser-agent.runtime", "waiting_for_user_input", this.logContext(`Esperando dato del usuario: ${fieldName}`, {
          session: this.session, kind, fieldName, url: url || undefined, username: username || undefined,
        }));

        const resolution = await pending;
        await this.options.onStateChange?.("running");
        debugInfo("browser-agent.runtime", "user_input_resumed", this.logContext("Dato recibido; reanudando navegación", {
          session: this.session, kind: resolution.kind,
        }));

        if (resolution.kind === "correction") {
          return JSON.stringify({
            status: "correction_requested",
            action: resolution.action,
            message: resolution.message,
            instruction: "El usuario corrigió el dato solicitado. No abortes: vuelve a inspeccionar el formulario y solicita nuevamente usuario/correo y después contraseña según corresponda, conservando esta misma sesión.",
          });
        }
        if (resolution.kind === "password") {
          return JSON.stringify({
            status: "received",
            kind: "password",
            credential_ref: resolution.credentialRef,
            url: resolution.url,
            username: resolution.username,
            instruction: "La misma tarea y sesión del navegador continúan activas. Usa credential_ref con browser_auth_login y sigue desde la página actual.",
          });
        }
        if (resolution.kind === "otp") {
          return JSON.stringify({
            status: "received",
            kind: "otp",
            secret_ref: resolution.secretRef,
            instruction: "La misma tarea y sesión del navegador continúan activas. Usa secret_ref con browser_fill_secret en el campo correspondiente.",
          });
        }
        return JSON.stringify({
          status: "received",
          kind: resolution.kind,
          value: resolution.value,
          instruction: "La misma tarea y sesión del navegador continúan activas. Usa el dato y sigue desde la página actual; no abras una nueva tarea.",
        });
      }
      case "browser_fill_secret": {
        const selector = typeof args.selector === "string" ? args.selector.trim() : "";
        const secretRef = typeof args.secret_ref === "string" ? args.secret_ref.trim() : "";
        const credentialRef = typeof args.credential_ref === "string" ? args.credential_ref.trim() : "";
        if (!selector || (!secretRef && !credentialRef)) {
          return "Error: selector y una referencia secret_ref o credential_ref son obligatorios.";
        }
        if (secretRef && credentialRef) return "Error: usa solo secret_ref o credential_ref, no ambos.";

        if (credentialRef) {
          const credential = this.options.credentials.resolve(credentialRef, this.options.jid);
          if (!credential) return "Error: la referencia de credencial no existe, expiró o pertenece a otro usuario.";
          // Contraseña inyectada directamente al proceso del navegador. El valor no
          // aparece en argumentos de tool, resultados, logs ni contexto del LLM.
          return await this.run(["fill", selector, credential.password], signal);
        }

        const secret = this.options.credentials.getSecret(secretRef, this.options.jid, true);
        if (!secret) return "Error: la referencia secreta no existe, expiró o pertenece a otro usuario.";
        return await this.run(["fill", selector, secret.value], signal);
      }
      case "browser_auth_confirm": {
        const ref = typeof args.credential_ref === "string" ? args.credential_ref.trim() : "";
        if (!ref) return "Error: credential_ref es obligatorio.";
        const credential = this.options.credentials.resolve(ref, this.options.jid);
        if (!credential) return "Error: la referencia de credencial no existe, expiró o pertenece a otro usuario.";

        if (credential.source === "temporary") {
          const saved = this.options.credentials.saveProfile({
            jid: this.options.jid,
            url: credential.url,
            username: credential.username,
            password: credential.password,
          });
          this.options.credentials.delete(credential.ref);
          return JSON.stringify({
            ok: true,
            credential_profile_ref: saved.ref,
            username: saved.username,
            url: saved.url,
            note: "Login manual confirmado. La contraseña quedó cifrada para futuras reautenticaciones.",
          });
        }

        if (credential.profileRef) this.options.credentials.markProfileUsed(credential.profileRef, this.options.jid);
        return JSON.stringify({
          ok: true,
          credential_profile_ref: credential.profileRef ?? credential.ref,
          username: credential.username,
          url: credential.url,
          note: "Login manual confirmado con una credencial persistente existente.",
        });
      }
      case "browser_auth_login": {
        let ref = typeof args.credential_ref === "string" ? args.credential_ref.trim() : "";
        const requestedUrl = typeof args.url === "string" ? args.url.trim() : "";
        const requestedUsername = typeof args.username === "string" ? args.username.trim() : "";

        if (!ref && requestedUrl) {
          const profiles = this.options.credentials.listProfiles(
            this.options.jid,
            requestedUrl,
            requestedUsername || undefined,
          );
          if (profiles.length === 1) ref = profiles[0]!.ref;
          else if (profiles.length > 1) {
            return `Error: hay ${profiles.length} cuentas guardadas para ese sitio. Usa browser_auth_profiles y selecciona credential_ref según el usuario correcto.`;
          } else {
            return "Error: no hay una credencial guardada para esa cuenta. Usa browser_request_user_input para solicitar primero el usuario o la contraseña que falte.";
          }
        }

        const credential = this.options.credentials.resolve(ref, this.options.jid);
        if (!credential) return "Error: la referencia de credencial segura no existe, expiró o pertenece a otro usuario.";
        const profile = `luna-temp-${stableHash(`${this.options.jid}:${credential.url}:${credential.username}:${this.options.runId}`)}`;
        await this.run([
          "auth", "save", profile,
          "--url", credential.url,
          "--username", credential.username,
          "--password-stdin",
        ], signal, credential.password, BROWSER_COMMAND_TIMEOUT_MS.auth);
        try {
          const result = await this.run(["auth", "login", profile, "--json"], signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.auth);
          let savedProfileRef = credential.profileRef;
          if (credential.source === "temporary") {
            const saved = this.options.credentials.saveProfile({
              jid: this.options.jid,
              url: credential.url,
              username: credential.username,
              password: credential.password,
            });
            savedProfileRef = saved.ref;
            this.options.credentials.delete(credential.ref);
          } else if (credential.profileRef) {
            this.options.credentials.markProfileUsed(credential.profileRef, this.options.jid);
          }
          return JSON.stringify({
            ok: true,
            login_result: result,
            credential_profile_ref: savedProfileRef,
            username: credential.username,
            url: credential.url,
            note: "La contraseña permaneció fuera del LLM. El perfil cifrado puede reutilizarse si la sesión web expira.",
          });
        } catch (error) {
          return JSON.stringify({
            ok: false,
            recoverable: true,
            username: credential.username,
            url: credential.url,
            error: error instanceof Error ? error.message : String(error),
            instruction: "El inicio de sesión no se confirmó. No termines la tarea. Conserva la página, inspecciona el formulario y usa browser_request_user_input para confirmar/corregir primero usuario o correo y después solicitar una nueva contraseña u OTP.",
          });
        } finally {
          // agent-browser recibe la contraseña solo mediante stdin para completar el
          // login actual. La copia persistente queda cifrada en el almacén de Luna;
          // eliminamos el perfil temporal del vault interno del CLI al terminar.
          const cleanupController = new AbortController();
          const cleanupTimer = setTimeout(() => cleanupController.abort(new Error("browser-auth-cleanup-timeout")), 5_000);
          try {
            await this.run(["auth", "delete", profile], cleanupController.signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.close);
          } catch {
            /* limpieza best-effort con señal independiente de la tarea cancelada */
          } finally {
            clearTimeout(cleanupTimer);
          }
        }
      }
      case "browser_close":
        return await this.run(["close"], signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.close);
      default:
        return `Error: herramienta de navegador desconocida "${name}".`;
    }
  }
}
