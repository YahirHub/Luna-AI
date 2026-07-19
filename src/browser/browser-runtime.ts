import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export interface BrowserExecutionOptions {
  jid: string;
  runId: string;
  taskId: string;
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
  }) => void | Promise<void>;
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

export class BrowserAgentExecution {
  private readonly sessionBase: string;
  private session: string;
  private readonly restoreName: string;
  private readonly binary: string;
  private readonly runtimeCwd: string;
  private recoveryCounter = 0;
  private screenshotCounter = 0;
  private downloadCounter = 0;
  private snapshotCounter = 0;
  private readCounter = 0;

  constructor(private readonly options: BrowserExecutionOptions) {
    const id = stableHash(`${options.jid}:${options.runId}`);
    const userState = stableHash(options.jid);
    this.sessionBase = `luna-${id}`;
    this.session = this.sessionBase;
    this.restoreName = `luna-${userState}`;
    this.binary = resolveAgentBrowserBinary();
    this.runtimeCwd = join(getAppDir(), "persistent", "browser", "runtime");
    mkdirSync(this.runtimeCwd, { recursive: true });
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
      AGENT_BROWSER_SESSION_NAME: this.restoreName,
      AGENT_BROWSER_CONTENT_BOUNDARIES: "true",
      AGENT_BROWSER_MAX_OUTPUT: "50000",
      // Debe quedar por debajo del timeout IPC del CLI (30 s). Así el daemon
      // devuelve un error controlado antes de que el cliente quede esperando.
      AGENT_BROWSER_DEFAULT_TIMEOUT: process.env.AGENT_BROWSER_DEFAULT_TIMEOUT?.trim() || "20000",
      AGENT_BROWSER_ENCRYPTION_KEY: encryptionKey(),
      ...(browserExecutable ? { AGENT_BROWSER_EXECUTABLE_PATH: browserExecutable } : {}),
    } as Record<string, string>;
  }

  private async run(
    args: string[],
    signal: AbortSignal,
    stdinText?: string,
    timeoutMs: number = BROWSER_COMMAND_TIMEOUT_MS.action,
  ): Promise<string> {
    if (signal.aborted) throw signal.reason ?? new Error("browser-cancelled");

    const command = args.slice(0, 2).join(" ") || "unknown";
    const startedAt = Date.now();
    const env = this.env();
    debugLog("browser.runtime", "command_started", {
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
        debugWarn("browser.runtime", "command_timeout", {
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
        debugLog("browser.runtime", "pipe_detached_after_cli_exit", {
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

      debugInfo("browser.runtime", "command_completed", {
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
  }

  private rotateSessionAfterHang(): void {
    this.recoveryCounter += 1;
    this.session = `${this.sessionBase}-recovery-${this.recoveryCounter}`;
    debugWarn("browser.runtime", "session_rotated", {
      runId: this.options.runId,
      session: this.session,
      recoveryCounter: this.recoveryCounter,
    });
  }

  private async openWithRecovery(url: string, signal: AbortSignal): Promise<string> {
    try {
      return await this.run(["open", url, "--json"], signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.open);
    } catch (error) {
      if (!(error instanceof BrowserCommandTimeoutError) || signal.aborted) throw error;

      // A veces la navegación terminó pero el CLI no devolvió control. Primero
      // comprobamos la URL de la sesión antes de reiniciarla.
      try {
        const currentOutput = await this.run(["get", "url", "--json"], signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.inspect);
        const currentUrl = extractCurrentUrl(currentOutput);
        if (currentUrl) {
          debugWarn("browser.runtime", "open_recovered_from_current_url", {
            runId: this.options.runId,
            requestedUrl: url,
            currentUrl,
          });
          return JSON.stringify({
            success: true,
            data: { url: currentUrl, recoveredFromOpenTimeout: true },
          });
        }
      } catch {
        // Continuamos con una sesión limpia.
      }

      // Si la sesión quedó trabada en el daemon, una sesión nueva evita esperar
      // hasta el timeout global de 20 minutos del subagente.
      this.rotateSessionAfterHang();
      debugWarn("browser.runtime", "open_retry", {
        runId: this.options.runId,
        url,
        session: this.session,
      });
      return await this.run(["open", url, "--json"], signal, undefined, BROWSER_COMMAND_TIMEOUT_MS.open);
    }
  }

  private resolveArtifact(kind: "screenshots" | "downloads", requested: string, fallback: string): { absolute: string; relative: string } {
    const name = safeName(basename(requested || fallback));
    const rel = `${this.options.agentDir}/browser/${kind}/${name}`.replace(/\\/g, "/");
    const absolute = this.options.workspace.resolvePath(this.options.jid, rel);
    mkdirSync(dirname(absolute), { recursive: true });
    return { absolute, relative: rel };
  }

  async executeTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
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

        // Registrar la espera ANTES de emitir el mensaje evita una carrera si el
        // usuario responde inmediatamente. La Promise mantiene viva esta misma
        // ejecución de browser-web y, por tanto, la misma sesión de agent-browser.
        const pending = this.options.credentials.waitForInput({
          jid: this.options.jid,
          kind,
          fieldName,
          originalText: this.options.resumePrompt || `Continúa la misión de navegador: ${message || fieldName}`,
          url: url || undefined,
          username: username || undefined,
          message: message || undefined,
        }, signal);

        try {
          await this.options.onUserInputRequest?.({
            kind,
            fieldName,
            url: url || undefined,
            username: username || undefined,
            message: message || undefined,
          });
        } catch (error) {
          this.options.credentials.cancelPendingInput(this.options.jid, error);
          throw error;
        }

        debugInfo("browser.runtime", "waiting_for_user_input", {
          runId: this.options.runId,
          session: this.session,
          kind,
          fieldName,
          url: url || undefined,
          username: username || undefined,
        });

        const resolution = await pending;
        debugInfo("browser.runtime", "user_input_resumed", {
          runId: this.options.runId,
          session: this.session,
          kind: resolution.kind,
        });

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
