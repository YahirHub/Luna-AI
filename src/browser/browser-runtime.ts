import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { basename, dirname, extname, join } from "node:path";
import { getAppDir } from "../utils.ts";
import {
  agentBrowserGenericName,
  agentBrowserNativeName,
  resolveManagedAgentBrowserChrome,
  resolveSystemBrowserExecutable,
  supportsManagedAgentBrowserChrome,
} from "./browser-discovery.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import {
  browserLoginRequiresIdentityConfirmation,
  extractBrowserLoginIntent,
  type BrowserCredentialStore,
  type BrowserInputKind,
  type BrowserInputResolution,
} from "./browser-credentials.ts";
import { detectBrowserHumanInputNeed, normalizeBrowserRequestedInputKind } from "./browser-human-input.ts";
import { debugInfo, debugLog, debugWarn } from "../debug.ts";
import { createProcessOutputCollector } from "./process-output.ts";
import { extractPublicUrls } from "../public-web/public-web-runtime.ts";

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
  const directory = join(getAppDir(), "persistent", "browser");
  const path = join(directory, "encryption.key");
  mkdirSync(directory, { recursive: true });
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const key = randomBytes(32).toString("hex");
  writeFileSync(path, `${key}\n`, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* Windows */ }
  return key;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "file";
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function runtimeDirName(value: string): string {
  const readable = safeName(value).slice(0, 54);
  return `${readable}-${stableHash(value).slice(0, 12)}`;
}

export interface BrowserAutomaticInputRequest {
  kind: BrowserInputKind;
  field_name: string;
  url?: string;
  username?: string;
  message: string;
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
  /** Referencia segura entregada explícitamente al crear esta ejecución. Autoriza esa identidad sin inferirla por dominio. */
  initialCredentialRef?: string;
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

function extractJsonCommandData(output: string): unknown {
  try {
    const parsed = JSON.parse(output) as { data?: unknown };
    return parsed.data ?? parsed;
  } catch {
    return output;
  }
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a = 0, b = 0, c = 0] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && c <= 2)
    || a >= 224;
}

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateIpv4(ip);
  const normalized = ip.toLowerCase().split("%")[0] ?? "";
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc")
    || normalized.startsWith("fd") || normalized.startsWith("fe") || normalized.startsWith("ff");
}

async function validateDownloadUrl(rawUrl: string): Promise<URL> {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error("Solo se permiten assets http/https sin credenciales embebidas.");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("No se descargan assets desde hosts locales o internos.");
  }
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("El asset resuelve a una red privada o reservada.");
  }
  return url;
}

function assetExtension(url: URL, contentType: string | null): string {
  const fromPath = extname(url.pathname).toLowerCase().replace(/[^.a-z0-9]/g, "");
  if (fromPath && fromPath.length <= 8) return fromPath;
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
  const byType: Record<string, string> = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
    "image/svg+xml": ".svg", "image/x-icon": ".ico", "image/vnd.microsoft.icon": ".ico",
  };
  return byType[type ?? ""] ?? ".bin";
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
  private readonly profileRootDir: string;
  private readonly stateFile: string;
  private readonly runStateFile: string;
  private readonly profileLeaseKey: string;
  private releaseProfileLease?: () => void;
  private recoveryCounter = 0;
  private screenshotCounter = 0;
  private downloadCounter = 0;
  private snapshotCounter = 0;
  private readCounter = 0;
  private inspectCounter = 0;
  private inputRequestCounter = 0;
  private readonly activeChildren = new Set<any>();
  private commandTail: Promise<void> = Promise.resolve();
  private keepAliveTimer?: ReturnType<typeof setInterval>;
  private keepAliveController?: AbortController;
  private finalizePromise?: Promise<void>;
  private sessionTouched = false;
  private cancelled = false;
  private finalizing = false;
  private waitingForUser = false;
  /** Identidad elegida explícitamente en la misión original o por una respuesta humana durante esta ejecución. */
  private confirmedLoginUsername = "";

  constructor(private readonly options: BrowserExecutionOptions) {
    const initialLoginIntent = extractBrowserLoginIntent(options.resumePrompt ?? "");
    this.confirmedLoginUsername = initialLoginIntent.username.trim();
    const id = stableHash(`${options.jid}:${options.runId}`);
    const userState = stableHash(options.jid);
    this.sessionBase = `luna-${id}`;
    this.session = this.sessionBase;
    this.restoreName = this.sessionBase;
    this.binary = resolveAgentBrowserBinary();
    this.runRuntimeDir = join(getAppDir(), "persistent", "browser", "runs", runtimeDirName(options.runId));
    this.runtimeCwd = this.runRuntimeDir;
    // Cada agente obtiene HOME y perfil propios. Compartir el directorio físico de
    // Chrome impedía la concurrencia real y hacía que un agente esperando datos
    // bloqueara a todos los demás. El estado autenticado portable se comparte
    // mediante stateFile y solo su escritura final se serializa.
    this.persistentHome = join(this.runRuntimeDir, "home");
    this.profileRootDir = join(this.runRuntimeDir, "profiles");
    this.stateFile = join(getAppDir(), "persistent", "browser", "users", userState, "session-state.json");
    this.runStateFile = join(this.runRuntimeDir, "session-state-export.json");
    this.profileLeaseKey = `${userState}:state-save`;
    mkdirSync(this.runtimeCwd, { recursive: true });
    mkdirSync(this.persistentHome, { recursive: true });
    mkdirSync(this.currentProfileDir(), { recursive: true });
    mkdirSync(dirname(this.stateFile), { recursive: true });
  }

  /**
   * Una orden explícita de iniciar sesión no autoriza a Luna a escoger una
   * cuenta por heurística. Si el usuario no indicó identidad y tampoco llegó
   * una credential_ref capturada explícitamente, primero debe preguntarla.
   */
  private requiresExplicitLoginIdentity(): boolean {
    return browserLoginRequiresIdentityConfirmation(
      this.options.resumePrompt ?? "",
      this.confirmedLoginUsername,
      this.options.initialCredentialRef ?? "",
    );
  }

  private identityRequiredResult(): string {
    return JSON.stringify({
      ok: false,
      recoverable: true,
      reason: "login_identity_required",
      instruction: "El usuario pidió iniciar sesión pero no indicó qué cuenta usar. No infieras ni reutilices un correo por el dominio, por una cuenta guardada, por un único perfil disponible ni por un valor prellenado en la página. Usa browser_request_user_input con kind=username y continúa únicamente después de que el usuario confirme la identidad.",
    }, null, 2);
  }

  private currentProfileDir(): string {
    return join(this.profileRootDir, `attempt-${this.recoveryCounter}`);
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
      AGENT_BROWSER_PROFILE: this.currentProfileDir(),
      ...(existsSync(this.stateFile) ? { AGENT_BROWSER_STATE: this.stateFile } : {}),
      AGENT_BROWSER_CONTENT_BOUNDARIES: "true",
      AGENT_BROWSER_MAX_OUTPUT: "500000",
      // Debe quedar por debajo del timeout IPC del CLI (30 s). Así el daemon
      // devuelve un error controlado antes de que el cliente quede esperando.
      AGENT_BROWSER_DEFAULT_TIMEOUT: process.env.AGENT_BROWSER_DEFAULT_TIMEOUT?.trim() || "20000",
      // El daemon pertenece exclusivamente a esta ejecución. Un keepalive interno
      // evita que expire mientras el agente sigue razonando o espera datos del usuario.
      // El margen de 60 s evita que el daemon desaparezca entre la última tool y
      // finalize(), obligando a Chrome a reabrir un profile que aún conserva lock.
      AGENT_BROWSER_IDLE_TIMEOUT_MS: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS?.trim() || "60000",
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
    debugLog("browser-agent.runtime", "command_started", {
      runId: this.options.runId,
      session: this.session,
      command,
      timeoutMs,
      executablePath: env.AGENT_BROWSER_EXECUTABLE_PATH ?? "managed-default",
    });

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
        debugWarn("browser-agent.runtime", "command_timeout", {
          runId: this.options.runId,
          session: this.session,
          command,
          timeoutMs,
          durationMs: Date.now() - startedAt,
        });
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
        debugLog("browser-agent.runtime", "pipe_detached_after_cli_exit", {
          runId: this.options.runId,
          session: this.session,
          command,
          stdoutWasOpen,
          stderrWasOpen,
        });
      }

      if (outcome.exitCode !== 0) {
        throw new Error((stderr || stdout || `agent-browser terminó con código ${outcome.exitCode}`).trim());
      }

      debugInfo("browser-agent.runtime", "command_completed", {
        runId: this.options.runId,
        session: this.session,
        command,
        durationMs: Date.now() - startedAt,
        outputChars: (stdout || stderr).length,
      });
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
    mkdirSync(this.currentProfileDir(), { recursive: true });
    debugWarn("browser-agent.runtime", "session_rotated", {
      runId: this.options.runId,
      session: this.session,
      recoveryCounter: this.recoveryCounter,
    });
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
      debugWarn("browser-agent.runtime", "initial_snapshot_failed", {
        runId: this.options.runId,
        agentId: this.options.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
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
          debugWarn("browser-agent.runtime", "open_recovered_from_current_url", {
            runId: this.options.runId,
            requestedUrl: url,
            currentUrl,
          });
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
      debugWarn("browser-agent.runtime", "open_retry", {
        runId: this.options.runId,
        url,
        session: this.session,
      });
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

  private saveInspection(kind: string, output: string, extension = "txt"): string {
    this.inspectCounter += 1;
    const filename = `${String(this.inspectCounter).padStart(3, "0")}-${safeName(kind)}.${extension}`;
    const relative = `${this.options.agentDir}/browser/inspection/${filename}`;
    this.options.workspace.writeText(this.options.jid, relative, output.endsWith("\n") ? output : `${output}\n`);
    if (output.length <= 14_000) return `${output}\n\n[SISTEMA: salida completa guardada en ${relative}]`;
    return `${output.slice(0, 12_000)}\n\n[...salida completa guardada en ${relative}; ${output.length} caracteres...]`;
  }

  private async collectAssetManifest(signal: AbortSignal): Promise<Record<string, unknown>> {
    const script = `(() => {
      const absolute = (value) => { try { return new URL(value, document.baseURI).href; } catch { return null; } };
      const unique = (values) => [...new Set(values.filter(Boolean))];
      const images = unique([...document.images].flatMap((img) => [absolute(img.currentSrc || img.src), ...String(img.srcset || '').split(',').map((item) => absolute(item.trim().split(/\\s+/)[0]))]));
      const icons = unique([...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="mask-icon"]')].map((node) => absolute(node.href)));
      const stylesheets = unique([...document.querySelectorAll('link[rel="stylesheet"]')].map((node) => absolute(node.href)));
      const scripts = unique([...document.scripts].map((node) => absolute(node.src)));
      const links = unique([...document.querySelectorAll('a[href]')].map((node) => absolute(node.href)));
      return { pageUrl: location.href, title: document.title, images, icons, stylesheets, scripts, links };
    })()`;
    const output = await this.run(["eval", script, "--json"], signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.inspect);
    let value = extractJsonCommandData(output);
    if (value && typeof value === "object" && "result" in (value as Record<string, unknown>)) {
      value = (value as Record<string, unknown>).result;
    }
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch { /* se conserva texto */ }
    }
    return value && typeof value === "object" ? value as Record<string, unknown> : { raw: value };
  }

  private async fetchAsset(urlValue: string, signal: AbortSignal): Promise<{ bytes: Uint8Array; url: URL; contentType: string | null }> {
    let url = await validateDownloadUrl(urlValue);
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      const response = await fetch(url, { signal, redirect: "manual", headers: { "user-agent": "Luna-AI-browser-agent/1.0" } });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error(`Redirección HTTP ${response.status} sin Location.`);
        url = await validateDownloadUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > 8_000_000) throw new Error("Asset mayor a 8 MB.");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 8_000_000) throw new Error("Asset mayor a 8 MB.");
      return { bytes, url, contentType: response.headers.get("content-type") };
    }
    throw new Error("Demasiadas redirecciones.");
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
      debugWarn("browser-agent.runtime", "input_request_screenshot_failed", {
        runId: this.options.runId,
        agentId: this.options.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
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
    debugWarn("browser-agent.runtime", "execution_cancelled", {
      runId: this.options.runId,
      session: this.session,
      reason: reason.message,
    });
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

  private mergePersistentState(): boolean {
    if (!existsSync(this.runStateFile)) return false;
    const incoming = JSON.parse(readFileSync(this.runStateFile, "utf8")) as unknown;
    let base: unknown = {};
    if (existsSync(this.stateFile)) {
      try { base = JSON.parse(readFileSync(this.stateFile, "utf8")) as unknown; } catch { base = {}; }
    }
    writeJsonFileAtomically(this.stateFile, mergeBrowserStorageStates(base, incoming));
    return true;
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
            try { rmSync(this.runStateFile, { force: true }); } catch { /* best effort */ }
            await this.run(["state", "save", this.runStateFile, "--json"], controller.signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.close);
            if (!existsSync(this.runStateFile)) {
              // Algunas versiones del daemon pueden responder antes de que el archivo
              // quede visible. Un único reintento corto evita ENOENT sin convertir el
              // cierre en un bucle de recuperación.
              await new Promise((resolve) => setTimeout(resolve, 150));
              await this.run(["state", "save", this.runStateFile, "--json"], controller.signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.close);
            }
            if (!existsSync(this.runStateFile)) {
              debugWarn("browser-agent.runtime", "persistent_state_export_missing", {
                runId: this.options.runId,
                session: this.session,
                exportPath: this.runStateFile,
              });
            } else {
              this.releaseProfileLease = await acquireBrowserProfileLease(this.profileLeaseKey, controller.signal);
              if (this.mergePersistentState()) {
                debugInfo("browser-agent.runtime", "persistent_state_saved", {
                  runId: this.options.runId,
                  session: this.session,
                  stateFile: this.stateFile,
                  strategy: "merge",
                });
              }
            }
          } catch (error) {
            debugWarn("browser-agent.runtime", "persistent_state_save_failed", {
              runId: this.options.runId,
              session: this.session,
              error: error instanceof Error ? error.message : String(error),
            });
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

  isWaitingForUser(): boolean {
    return this.waitingForUser;
  }

  /**
   * Última barrera de seguridad contra cierres prematuros del LLM. Si el
   * subagente intenta terminar diciendo que le falta una credencial, OTP,
   * CAPTCHA u otro dato humano, construye una solicitud segura usando el
   * estado real de la sesión. No extrae ni inventa secretos.
   */
  async resolveAutomaticInputRequest(
    finalOutput: string,
    mission: string,
    signal: AbortSignal,
  ): Promise<BrowserAutomaticInputRequest | null> {
    const missionIntent = extractBrowserLoginIntent(mission);
    const identityPending = this.requiresExplicitLoginIdentity();
    const need = detectBrowserHumanInputNeed(finalOutput, mission);
    // Incluso si el navegador abrió una sesión persistida y el modelo afirma
    // que el login ya está listo, una nueva orden explícita de autenticación no
    // puede finalizar hasta saber qué identidad eligió realmente el usuario.
    if (!need && !identityPending) return null;

    const outputIntent = extractBrowserLoginIntent(finalOutput);
    let url = missionIntent.url || outputIntent.url;
    // Para una misión que pide login, solo confiamos en la identidad escrita
    // por el usuario o confirmada mediante browser_request_user_input. El texto
    // final del modelo no puede convertir una inferencia suya en autorización.
    let username = identityPending ? "" : (this.confirmedLoginUsername || missionIntent.username);
    if (!identityPending && !missionIntent.loginRequested && !username) username = outputIntent.username;

    if (this.sessionTouched) {
      try {
        const current = await this.run(["get", "url", "--json"], signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.inspect);
        url = extractCurrentUrl(current) || url;
      } catch {
        // Si la página dejó de responder conservamos la URL de la misión.
      }
    }

    let kind: BrowserInputKind = identityPending ? "username" : need!.kind;
    let fieldName = identityPending ? "usuario o correo" : need!.fieldName;
    let message = identityPending
      ? "Antes de iniciar o aceptar una sesión existente, necesito que confirmes qué usuario/correo debo usar para esta tarea."
      : need!.message;

    // Una contraseña siempre debe quedar asociada a URL + identidad. Si falta
    // una de esas piezas pedimos primero la información no secreta y dejamos
    // que la misma ejecución solicite la contraseña en el paso siguiente.
    if (kind === "password" && !username) {
      kind = "username";
      fieldName = "usuario o correo";
      message = "Antes de solicitar la contraseña, el sistema necesita identificar la cuenta correcta para continuar esta misma tarea.";
    } else if (kind === "password" && !url) {
      kind = "text";
      fieldName = "sitio o URL";
      message = "Antes de solicitar la contraseña, el sistema necesita saber a qué sitio pertenece la cuenta.";
    }

    return {
      kind,
      field_name: fieldName,
      url: url || undefined,
      username: username || undefined,
      message,
    };
  }

  async executeTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    if (this.cancelled || this.finalizing) throw new Error("browser-agent-cancelled");

    // Cuando el usuario ordenó iniciar sesión sin indicar la cuenta, ninguna
    // acción capaz de avanzar/autocompletar el login puede ejecutarse todavía.
    // Se permite abrir/inspeccionar la página y, por supuesto, pedir el dato.
    // Esto impide que el modelo use un correo guardado, prellenado o inferido.
    if (this.requiresExplicitLoginIdentity() && new Set([
      "browser_click",
      "browser_fill",
      "browser_type",
      "browser_press",
      "browser_auth_profiles",
      "browser_auth_login",
      "browser_fill_secret",
      "browser_auth_confirm",
    ]).has(name)) {
      return this.identityRequiredResult();
    }

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
      case "browser_get_html": {
        const selector = typeof args.selector === "string" && args.selector.trim() ? args.selector.trim() : "html";
        const output = await this.run(["get", "html", selector, "--json"], signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.inspect);
        const value = extractJsonCommandData(output);
        const html = typeof value === "string" ? value : JSON.stringify(value, null, 2);
        const requested = typeof args.filename === "string" && args.filename.trim() ? args.filename.trim() : `page-${Date.now()}.html`;
        const relative = `${this.options.agentDir}/browser/html/${safeName(requested.endsWith(".html") ? requested : `${requested}.html`)}`;
        this.options.workspace.writeText(this.options.jid, relative, html);
        return `${html.slice(0, 12_000)}${html.length > 12_000 ? "\n\n[...HTML completo guardado en el archivo...]" : ""}\n\n[SISTEMA: HTML guardado en ${relative}; ${html.length} caracteres]`;
      }
      case "browser_find_html": {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) return "Error: query es obligatorio.";
        const mode = ["text", "urls", "media"].includes(String(args.mode)) ? String(args.mode) as "text" | "urls" | "media" : "text";
        const selector = typeof args.selector === "string" && args.selector.trim() ? args.selector.trim() : "html";
        const maxMatches = Number.isInteger(args.max_matches) ? Math.max(1, Math.min(100, Number(args.max_matches))) : 30;
        const output = await this.run(["get", "html", selector, "--json"], signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.inspect);
        const value = extractJsonCommandData(output);
        const html = typeof value === "string" ? value : JSON.stringify(value, null, 2);
        let result: Record<string, unknown>;
        if (mode === "urls" || mode === "media") {
          let pageUrl = "https://invalid.local/";
          try {
            const current = await this.run(["get", "url", "--json"], signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.inspect);
            pageUrl = extractCurrentUrl(current) || pageUrl;
          } catch { /* conserva base neutra si la URL actual no pudo leerse */ }
          const matches = extractPublicUrls(html, pageUrl, mode === "media" ? "media" : "all", query, maxMatches);
          result = { query, mode, selector, html_chars: html.length, match_count: matches.length, matches };
        } else {
          const lower = html.toLowerCase();
          const needleText = query.toLowerCase();
          const matches: Array<{ index: number; snippet: string }> = [];
          let offset = 0;
          while (matches.length < maxMatches) {
            const index = lower.indexOf(needleText, offset);
            if (index < 0) break;
            const start = Math.max(0, index - 180);
            const end = Math.min(html.length, index + query.length + 260);
            matches.push({ index, snippet: html.slice(start, end).replace(/\s+/g, " ").trim() });
            offset = index + Math.max(1, query.length);
          }
          result = { query, mode, selector, html_chars: html.length, match_count: matches.length, matches };
        }
        const relative = `${this.options.agentDir}/browser/inspection/find-html-${Date.now()}.json`;
        const serialized = `${JSON.stringify(result, null, 2)}\n`;
        this.options.workspace.writeText(this.options.jid, relative, serialized);
        return `${serialized.slice(0, 14_000)}\n[SISTEMA: coincidencias completas guardadas en ${relative}]`;
      }
      case "browser_eval": {
        const script = typeof args.script === "string" ? args.script.trim() : "";
        if (!script) return "Error: script es obligatorio.";
        if (/document\.cookie|password[^\n]{0,20}value|navigator\.clipboard|indexedDB/i.test(script)) {
          return "Error: browser_eval no permite extraer cookies, contraseñas, portapapeles ni almacenes sensibles.";
        }
        const output = await this.run(["eval", script, "--json"], signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.inspect);
        const filename = typeof args.filename === "string" && args.filename.trim() ? safeName(args.filename.trim()) : "eval-output.json";
        const relative = `${this.options.agentDir}/browser/inspection/${filename}`;
        this.options.workspace.writeText(this.options.jid, relative, output);
        return `${output.slice(0, 14_000)}${output.length > 14_000 ? "\n\n[...salida completa guardada en el archivo...]" : ""}\n\n[SISTEMA: salida completa guardada en ${relative}]`;
      }
      case "browser_console": {
        const output = await this.run(args.clear === true ? ["console", "--clear", "--json"] : ["console", "--json"], signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.inspect);
        return this.saveInspection("console", output, "json");
      }
      case "browser_errors": {
        const output = await this.run(args.clear === true ? ["errors", "--clear", "--json"] : ["errors", "--json"], signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.inspect);
        return this.saveInspection("errors", output, "json");
      }
      case "browser_network_requests": {
        const cmd = ["network", "requests"];
        if (args.clear === true) cmd.push("--clear");
        if (typeof args.filter === "string" && args.filter.trim()) cmd.push("--filter", args.filter.trim());
        if (typeof args.resource_types === "string" && args.resource_types.trim()) cmd.push("--type", args.resource_types.trim());
        if (typeof args.method === "string" && args.method.trim()) cmd.push("--method", args.method.trim());
        if (typeof args.status === "string" && args.status.trim()) cmd.push("--status", args.status.trim());
        cmd.push("--json");
        const output = await this.run(cmd, signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.inspect);
        return this.saveInspection("network-requests", output, "json");
      }
      case "browser_network_request": {
        const requestId = typeof args.request_id === "string" ? args.request_id.trim() : "";
        if (!requestId) return "Error: request_id es obligatorio.";
        const output = await this.run(["network", "request", requestId, "--json"], signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.inspect);
        return this.saveInspection(`network-request-${requestId}`, output, "json");
      }
      case "browser_extract_assets": {
        const manifest = await this.collectAssetManifest(signal);
        const requested = typeof args.filename === "string" && args.filename.trim() ? args.filename.trim() : "assets-manifest.json";
        const relative = `${this.options.agentDir}/browser/extracted/${safeName(requested.endsWith(".json") ? requested : `${requested}.json`)}`;
        const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
        this.options.workspace.writeText(this.options.jid, relative, serialized);
        return `${serialized.slice(0, 14_000)}\n[SISTEMA: manifest completo guardado en ${relative}]`;
      }
      case "browser_download_assets": {
        const manifest = await this.collectAssetManifest(signal);
        const pageUrl = typeof manifest.pageUrl === "string" ? new URL(manifest.pageUrl) : undefined;
        const images = Array.isArray(manifest.images) ? manifest.images : [];
        const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
        const candidates = [...new Set([...icons, ...images].filter((item): item is string => typeof item === "string" && /^https?:\/\//i.test(item)))];
        const maxFiles = Number.isInteger(args.max_files) ? Math.max(1, Math.min(150, Number(args.max_files))) : 80;
        const includeExternal = args.include_external !== false;
        const folderName = typeof args.folder === "string" && args.folder.trim() ? args.folder.trim().replace(/^\/+|\/+$/g, "") : "browser/downloads/assets";
        const results: Array<Record<string, unknown>> = [];
        let totalBytes = 0;
        for (const [index, candidate] of candidates.slice(0, maxFiles).entries()) {
          try {
            const candidateUrl = new URL(candidate);
            if (!includeExternal && pageUrl && candidateUrl.hostname !== pageUrl.hostname) {
              results.push({ url: candidate, status: "skipped", reason: "external-host" });
              continue;
            }
            const downloaded = await this.fetchAsset(candidate, signal);
            if (totalBytes + downloaded.bytes.byteLength > 50_000_000) {
              results.push({ url: candidate, status: "skipped", reason: "total-limit" });
              break;
            }
            totalBytes += downloaded.bytes.byteLength;
            const base = safeName(basename(downloaded.url.pathname).replace(/\.[^.]+$/, "") || `asset-${index + 1}`);
            const extension = assetExtension(downloaded.url, downloaded.contentType);
            const relative = `${this.options.agentDir}/${folderName}/${String(index + 1).padStart(3, "0")}-${base}${extension}`;
            this.options.workspace.writeBuffer(this.options.jid, relative, downloaded.bytes);
            this.options.workspace.registerArtifact(this.options.jid, relative, "browser-web", { taskId: this.options.taskId, temporary: false });
            results.push({ url: candidate, finalUrl: downloaded.url.href, status: "downloaded", path: relative, bytes: downloaded.bytes.byteLength });
          } catch (error) {
            results.push({ url: candidate, status: "failed", error: error instanceof Error ? error.message : String(error) });
          }
        }
        const result = { pageUrl: manifest.pageUrl, discovered: candidates.length, processed: results.length, totalBytes, results };
        const relative = `${this.options.agentDir}/${folderName}/download-manifest.json`;
        this.options.workspace.writeText(this.options.jid, relative, `${JSON.stringify(result, null, 2)}\n`);
        return `${JSON.stringify(result, null, 2).slice(0, 14_000)}\n\n[SISTEMA: manifest completo guardado en ${relative}]`;
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
      case "browser_pdf": {
        const requested = typeof args.filename === "string" ? args.filename : "";
        const file = this.resolveArtifact("downloads", requested, "page.pdf");
        const pdfPath = file.absolute.toLowerCase().endsWith(".pdf") ? file.absolute : `${file.absolute}.pdf`;
        const relative = file.relative.toLowerCase().endsWith(".pdf") ? file.relative : `${file.relative}.pdf`;
        await this.run(["pdf", pdfPath], signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.screenshot);
        this.options.workspace.registerArtifact(this.options.jid, relative, "browser-web", { taskId: this.options.taskId, temporary: false });
        return JSON.stringify({ ok: true, path: relative, kind: "pdf" });
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
        let kind: BrowserInputKind = ["username", "password", "otp", "secret", "text"].includes(kindRaw)
          ? kindRaw as BrowserInputKind
          : "text";
        let fieldName = typeof args.field_name === "string" ? args.field_name.trim() : "";
        let url = typeof args.url === "string" ? args.url.trim() : "";
        let username = typeof args.username === "string" ? args.username.trim() : "";
        let message = typeof args.message === "string" ? args.message.trim() : "";
        if (!fieldName) return "Error: field_name es obligatorio.";

        // La clasificación del modelo no es una frontera de seguridad. Si el
        // nombre o explicación del campo revela que es un secreto, elevamos el
        // tipo antes de pedirlo para que la respuesta nunca vuelva al LLM.
        kind = normalizeBrowserRequestedInputKind(kind, fieldName, message);

        if (this.requiresExplicitLoginIdentity() && kind !== "username") {
          kind = "username";
          fieldName = "usuario o correo";
          username = "";
          message = "El usuario pidió iniciar sesión pero todavía no confirmó qué cuenta usar. Indica el usuario/correo antes de solicitar cualquier contraseña o reutilizar una sesión guardada.";
        }

        if (kind === "password") {
          const missionIntent = extractBrowserLoginIntent(this.options.resumePrompt ?? "");
          url ||= missionIntent.url;
          username ||= this.confirmedLoginUsername || missionIntent.username;
          if (!url && this.sessionTouched) {
            try {
              const current = await this.run(["get", "url", "--json"], signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.inspect);
              url = extractCurrentUrl(current) ?? "";
            } catch {
              // La página actual puede haber dejado de responder.
            }
          }
          if (!username) {
            kind = "username";
            fieldName = "usuario o correo";
            message = message || "Necesito identificar la cuenta antes de solicitar su contraseña de forma segura.";
          } else if (!url) {
            kind = "text";
            fieldName = "sitio o URL";
            message = message || "Necesito asociar la credencial con el sitio correcto antes de solicitar la contraseña.";
          }
        }

        const requestId = `browser-input-${crypto.randomUUID()}`;
        const screenshotPath = await this.captureInputRequestScreenshot(signal);

        // Registrar la espera ANTES de emitir el mensaje evita una carrera si el
        // usuario responde inmediatamente. Cada agente conserva su requestId para
        // soportar varias solicitudes simultáneas dentro del mismo chat.
        this.waitingForUser = true;
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
          this.waitingForUser = false;
          this.options.credentials.cancelPendingInput(this.options.jid, error, requestId);
          throw error;
        }

        debugInfo("browser-agent.runtime", "waiting_for_user_input", {
          runId: this.options.runId,
          session: this.session,
          kind,
          fieldName,
          url: url || undefined,
          username: username || undefined,
        });

        let resolution: BrowserInputResolution;
        try {
          resolution = await pending;
        } finally {
          this.waitingForUser = false;
        }
        await this.options.onStateChange?.("running");
        debugInfo("browser-agent.runtime", "user_input_resumed", {
          runId: this.options.runId,
          session: this.session,
          kind: resolution.kind,
        });

        if (resolution.kind === "correction") {
          return JSON.stringify({
            status: "correction_requested",
            action: resolution.action,
            message: resolution.message,
            instruction: "El usuario corrigió el dato solicitado. No abortes: vuelve a inspeccionar el formulario y solicita nuevamente usuario/correo y después contraseña según corresponda, conservando esta misma sesión.",
          });
        }
        if (resolution.kind === "username") {
          this.confirmedLoginUsername = resolution.value.trim();
        } else if (resolution.kind === "password") {
          this.confirmedLoginUsername = resolution.username.trim();
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
        if (resolution.kind === "otp" || resolution.kind === "secret") {
          return JSON.stringify({
            status: "received",
            kind: resolution.kind,
            secret_ref: resolution.secretRef,
            instruction: "La misma tarea y sesión del navegador continúan activas. Usa secret_ref con browser_fill_secret en el campo correspondiente; nunca solicites ni muestres el valor en texto plano.",
          });
        }
        if (resolution.kind === "username" || resolution.kind === "text") {
          return JSON.stringify({
            status: "received",
            kind: resolution.kind,
            value: resolution.value,
            instruction: "La misma tarea y sesión del navegador continúan activas. Usa el dato y sigue desde la página actual; no abras una nueva tarea.",
          });
        }
        return "Error: respuesta humana no reconocida por browser-web.";
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
        const missionIntent = extractBrowserLoginIntent(this.options.resumePrompt ?? "");
        const authorizedUsername = this.confirmedLoginUsername || missionIntent.username;

        // URL sola jamás selecciona una identidad. Incluso con un único perfil
        // guardado, el usuario debe haber indicado/confirmado la cuenta.
        if (!ref && requestedUrl && !requestedUsername && !authorizedUsername) {
          return this.identityRequiredResult();
        }

        // En una orden explícita de login, un username inventado por el modelo
        // no sustituye la confirmación humana.
        if (missionIntent.loginRequested && authorizedUsername && requestedUsername
          && requestedUsername.toLowerCase() !== authorizedUsername.toLowerCase()) {
          return JSON.stringify({
            ok: false,
            recoverable: true,
            reason: "login_identity_mismatch",
            confirmed_username: authorizedUsername,
            instruction: "El usuario confirmó otra identidad. No cambies de cuenta por inferencia; usa únicamente el usuario/correo confirmado o vuelve a solicitar kind=username si el usuario quiere corregirlo.",
          }, null, 2);
        }

        if (!ref && requestedUrl) {
          const effectiveUsername = authorizedUsername || requestedUsername;
          if (!effectiveUsername) return this.identityRequiredResult();
          const profiles = this.options.credentials.listProfiles(
            this.options.jid,
            requestedUrl,
            effectiveUsername,
          );
          if (profiles.length === 1) ref = profiles[0]!.ref;
          else if (profiles.length > 1) {
            return JSON.stringify({
              ok: false,
              recoverable: true,
              reason: "ambiguous_account",
              accounts: profiles.map((profile) => ({
                credential_ref: profile.ref,
                username: profile.username,
                url: profile.url,
                label: profile.label,
              })),
              instruction: "Hay varias credenciales para la identidad ya confirmada. No elijas una por heurística; solicita una aclaración al usuario y después reintenta browser_auth_login.",
            }, null, 2);
          } else {
            return JSON.stringify({
              ok: false,
              recoverable: true,
              reason: "missing_credentials",
              url: requestedUrl,
              username: effectiveUsername,
              instruction: "No hay una credencial guardada para esa cuenta confirmada. No termines la tarea: solicita la contraseña con browser_request_user_input y continúa en esta misma sesión.",
            }, null, 2);
          }
        }

        const credential = this.options.credentials.resolve(ref, this.options.jid);
        if (!credential) {
          return JSON.stringify({
            ok: false,
            recoverable: true,
            reason: "credential_reference_unavailable",
            instruction: "La referencia segura expiró, fue eliminada o no pertenece a este usuario. No termines la tarea: consulta browser_auth_profiles o solicita nuevamente el dato con browser_request_user_input.",
          }, null, 2);
        }
        if (missionIntent.loginRequested && authorizedUsername
          && credential.username.toLowerCase() !== authorizedUsername.toLowerCase()) {
          return JSON.stringify({
            ok: false,
            recoverable: true,
            reason: "login_identity_mismatch",
            confirmed_username: authorizedUsername,
            credential_username: credential.username,
            instruction: "La credencial seleccionada pertenece a otra cuenta. No la uses: conserva la identidad confirmada por el usuario y solicita la contraseña correspondiente si hace falta.",
          }, null, 2);
        }
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
