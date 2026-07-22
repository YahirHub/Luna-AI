import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { AgenticRuntime } from "../workspace/workspace-exec.ts";
import { killProcessTree, prepareWorkspaceFileProcess } from "../workspace/workspace-exec.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import { writeJsonFileAtomically } from "../storage.ts";

export type ManagedProcessStatus = "starting" | "running" | "stopping" | "stopped" | "exited" | "failed" | "interrupted";

export interface ManagedProcessRecord {
  id: string;
  jid: string;
  name: string;
  runtime: AgenticRuntime;
  entry: string;
  cwd: string;
  args: string[];
  status: ManagedProcessStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  stoppedAt?: string;
  pid?: number;
  exitCode?: number | null;
  exitSignal?: string | null;
  restartCount: number;
  ownerGoalId?: string;
  sandbox?: string;
  error?: string;
  lastLogAt?: string;
}

interface ProcessFile { version: 1; processes: ManagedProcessRecord[] }
interface ActiveProcess { child: ChildProcess; recordId: string; jid: string }

const MAX_RECORDS = 80;
const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;
const KEEP_LOG_BYTES = 2 * 1024 * 1024;

function shortProcessId(): string {
  return `P-${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

function cleanName(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 100) || "proceso";
}

function isLiveStatus(status: ManagedProcessStatus): boolean {
  return status === "starting" || status === "running" || status === "stopping";
}

function tailText(path: string, maxBytes: number): string {
  if (!existsSync(path)) return "";
  const data = readFileSync(path);
  const start = Math.max(0, data.length - Math.max(1, maxBytes));
  return data.subarray(start).toString("utf8");
}

function tailLines(value: string, count: number): string {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  return lines.slice(-Math.max(1, count)).join("\n").trim();
}

export class UserProcessManager {
  private readonly active = new Map<string, ActiveProcess>();
  private readonly lastLogPersistAt = new Map<string, number>();

  constructor(private readonly workspace: WorkspaceManager) {
    this.recoverInterrupted();
  }

  private stateDir(jid: string): string {
    const dir = join(this.workspace.getUserDir(jid), "processes");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private filePath(jid: string): string {
    return join(this.stateDir(jid), "processes.json");
  }

  private logDir(jid: string, processId: string): string {
    const dir = join(this.stateDir(jid), "logs", processId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private stdoutPath(jid: string, processId: string): string {
    return join(this.logDir(jid, processId), "stdout.log");
  }

  private stderrPath(jid: string, processId: string): string {
    return join(this.logDir(jid, processId), "stderr.log");
  }

  private combinedPath(jid: string, processId: string): string {
    return join(this.logDir(jid, processId), "combined.log");
  }

  private load(jid: string): ProcessFile {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath(jid), "utf8")) as ProcessFile;
      if (parsed?.version === 1 && Array.isArray(parsed.processes)) return parsed;
    } catch {}
    return { version: 1, processes: [] };
  }

  private save(jid: string, file: ProcessFile): void {
    writeJsonFileAtomically(this.filePath(jid), file);
  }

  private patch(jid: string, id: string, patch: Partial<Omit<ManagedProcessRecord, "id" | "jid" | "createdAt">>): ManagedProcessRecord | null {
    const file = this.load(jid);
    const record = file.processes.find((item) => item.id === id);
    if (!record) return null;
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    this.save(jid, file);
    return structuredClone(record);
  }

  private recoverInterrupted(): void {
    try {
      const base = this.workspace.contextsDir;
      if (!existsSync(base)) return;
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const filePath = join(base, entry.name, "processes", "processes.json");
        if (!existsSync(filePath)) continue;
        try {
          const file = JSON.parse(readFileSync(filePath, "utf8")) as ProcessFile;
          let changed = false;
          const now = new Date().toISOString();
          for (const record of file.processes ?? []) {
            if (isLiveStatus(record.status)) {
              record.status = "interrupted";
              record.updatedAt = now;
              record.stoppedAt = now;
              record.pid = undefined;
              record.error = "Luna se reinició mientras este proceso estaba activo. Inícialo de nuevo o usa process_restart.";
              changed = true;
            }
          }
          if (changed) writeJsonFileAtomically(filePath, file);
        } catch {}
      }
    } catch {}
  }

  list(jid: string): ManagedProcessRecord[] {
    return this.load(jid).processes.slice(-MAX_RECORDS).reverse().map((item) => structuredClone(item));
  }

  get(jid: string, idOrName?: string): ManagedProcessRecord | undefined {
    const records = this.load(jid).processes;
    if (!idOrName) {
      const active = [...records].reverse().find((item) => isLiveStatus(item.status));
      const latest = active ?? records[records.length - 1];
      return latest ? structuredClone(latest) : undefined;
    }
    const needle = idOrName.trim().toLowerCase();
    const record = [...records].reverse().find((item) => item.id.toLowerCase() === needle || item.name.toLowerCase() === needle);
    return record ? structuredClone(record) : undefined;
  }

  private rotateLogIfNeeded(path: string): void {
    try {
      if (statSync(path).size <= MAX_LOG_FILE_BYTES) return;
      const retained = tailText(path, KEEP_LOG_BYTES);
      truncateSync(path, 0);
      writeFileSync(path, `[logs rotados por Luna]\n${retained}`, { encoding: "utf8", mode: 0o600 });
    } catch {}
  }

  private appendLog(jid: string, id: string, stream: "stdout" | "stderr", value: string): void {
    if (!value) return;
    const path = stream === "stdout" ? this.stdoutPath(jid, id) : this.stderrPath(jid, id);
    appendFileSync(path, value, { encoding: "utf8", mode: 0o600 });
    this.rotateLogIfNeeded(path);
    const timestamp = new Date().toISOString();
    const tagged = value.split(/(?<=\n)/).map((part) => part ? `[${timestamp}] [${stream.toUpperCase()}] ${part}` : "").join("");
    const combined = this.combinedPath(jid, id);
    appendFileSync(combined, tagged, { encoding: "utf8", mode: 0o600 });
    this.rotateLogIfNeeded(combined);
    const key = `${jid}:${id}`;
    const nowMs = Date.now();
    const previous = this.lastLogPersistAt.get(key) ?? 0;
    if (nowMs - previous >= 1_000) {
      this.lastLogPersistAt.set(key, nowMs);
      this.patch(jid, id, { lastLogAt: timestamp });
    }
  }

  private attachChild(jid: string, record: ManagedProcessRecord, child: ChildProcess): void {
    this.active.set(`${jid}:${record.id}`, { child, jid, recordId: record.id });
    child.stdout?.on("data", (chunk: Buffer | string) => this.appendLog(jid, record.id, "stdout", String(chunk)));
    child.stderr?.on("data", (chunk: Buffer | string) => this.appendLog(jid, record.id, "stderr", String(chunk)));
    child.on("error", (error) => {
      this.patch(jid, record.id, {
        status: "failed",
        error: error.message,
        stoppedAt: new Date().toISOString(),
        pid: undefined,
      });
      this.active.delete(`${jid}:${record.id}`);
      this.lastLogPersistAt.delete(`${jid}:${record.id}`);
    });
    child.on("close", (code, signal) => {
      const latest = this.get(jid, record.id);
      const wasStopping = latest?.status === "stopping" || latest?.status === "stopped";
      this.patch(jid, record.id, {
        status: wasStopping ? "stopped" : code === 0 ? "exited" : "failed",
        exitCode: code,
        exitSignal: signal,
        stoppedAt: new Date().toISOString(),
        pid: undefined,
        error: wasStopping || code === 0 ? undefined : `El proceso terminó con código ${code ?? "desconocido"}${signal ? ` (${signal})` : ""}.`,
      });
      this.active.delete(`${jid}:${record.id}`);
      this.lastLogPersistAt.delete(`${jid}:${record.id}`);
    });
  }

  start(jid: string, options: {
    name: string;
    runtime: AgenticRuntime;
    entry: string;
    cwd?: string;
    args?: string[];
    ownerGoalId?: string;
  }): ManagedProcessRecord {
    const name = cleanName(options.name);
    const existing = this.list(jid).find((item) => item.name.toLowerCase() === name.toLowerCase() && isLiveStatus(item.status));
    if (existing) throw new Error(`Ya existe un proceso activo con el nombre "${existing.name}" (${existing.id}).`);
    const prepared = prepareWorkspaceFileProcess({
      manager: this.workspace,
      jid,
      runtime: options.runtime,
      entry: options.entry,
      cwd: options.cwd,
      args: options.args,
    });
    const id = shortProcessId();
    const now = new Date().toISOString();
    const record: ManagedProcessRecord = {
      id,
      jid,
      name,
      runtime: options.runtime,
      entry: prepared.entryDisplayPath,
      cwd: options.cwd?.trim() || ".",
      args: Array.isArray(options.args) ? options.args.map((item) => String(item)).slice(0, 40) : [],
      status: "starting",
      createdAt: now,
      updatedAt: now,
      restartCount: 0,
      ownerGoalId: options.ownerGoalId,
      sandbox: prepared.sandbox,
    };
    const file = this.load(jid);
    file.processes.push(record);
    if (file.processes.length > MAX_RECORDS) file.processes = file.processes.slice(-MAX_RECORDS);
    this.save(jid, file);
    mkdirSync(this.logDir(jid, id), { recursive: true });

    const child = spawn(prepared.executable, prepared.args, {
      cwd: prepared.cwd,
      env: prepared.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const running = this.patch(jid, id, {
      status: "running",
      pid: child.pid,
      startedAt: new Date().toISOString(),
      error: undefined,
      exitCode: undefined,
      exitSignal: undefined,
    })!;
    this.attachChild(jid, running, child);
    return running;
  }

  stop(jid: string, idOrName?: string): ManagedProcessRecord {
    const record = this.get(jid, idOrName);
    if (!record) throw new Error("No se encontró el proceso solicitado.");
    if (!isLiveStatus(record.status)) return record;
    const active = this.active.get(`${jid}:${record.id}`);
    this.patch(jid, record.id, { status: "stopping" });
    if (active) killProcessTree(active.child);
    else this.patch(jid, record.id, { status: "stopped", stoppedAt: new Date().toISOString(), pid: undefined });
    return this.get(jid, record.id)!;
  }

  async restart(jid: string, idOrName?: string): Promise<ManagedProcessRecord> {
    const current = this.get(jid, idOrName);
    if (!current) throw new Error("No se encontró el proceso solicitado.");
    if (isLiveStatus(current.status)) {
      this.stop(jid, current.id);
      const deadline = Date.now() + 6_000;
      while (Date.now() < deadline && this.active.has(`${jid}:${current.id}`)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (this.active.has(`${jid}:${current.id}`)) {
        throw new Error(`No se pudo detener ${current.id} a tiempo para reiniciarlo de forma segura.`);
      }
    }
    const restarted = this.start(jid, {
      name: current.name,
      runtime: current.runtime,
      entry: current.entry,
      cwd: current.cwd,
      args: current.args,
      ownerGoalId: current.ownerGoalId,
    });
    return this.patch(jid, restarted.id, { restartCount: current.restartCount + 1 })!;
  }

  stopOwnedByGoal(jid: string, goalId: string): ManagedProcessRecord[] {
    const stopped: ManagedProcessRecord[] = [];
    for (const record of this.list(jid).filter((item) => item.ownerGoalId === goalId && isLiveStatus(item.status))) {
      stopped.push(this.stop(jid, record.id));
    }
    return stopped;
  }

  logs(jid: string, idOrName?: string, stream: "all" | "stdout" | "stderr" = "all", lineCount = 120): string {
    const record = this.get(jid, idOrName);
    if (!record) throw new Error("No se encontró el proceso solicitado.");
    const count = Math.max(1, Math.min(1000, Math.trunc(lineCount)));
    if (stream === "all") {
      let combined = tailLines(tailText(this.combinedPath(jid, record.id), 384_000), count);
      if (!combined) {
        const stdout = tailLines(tailText(this.stdoutPath(jid, record.id), 192_000), Math.ceil(count / 2));
        const stderr = tailLines(tailText(this.stderrPath(jid, record.id), 192_000), Math.ceil(count / 2));
        combined = [stdout ? `[STDOUT]\n${stdout}` : "", stderr ? `[STDERR]\n${stderr}` : ""].filter(Boolean).join("\n\n");
      }
      return [
        `Proceso: ${record.name} (${record.id})`,
        `Estado: ${record.status}${record.pid ? ` · PID ${record.pid}` : ""}`,
        combined ? `LOG COMBINADO CRONOLÓGICO:\n${combined}` : "LOG: (vacío)",
      ].join("\n\n");
    }
    const path = stream === "stdout" ? this.stdoutPath(jid, record.id) : this.stderrPath(jid, record.id);
    const content = tailLines(tailText(path, 256_000), count);
    return [
      `Proceso: ${record.name} (${record.id})`,
      `Estado: ${record.status}${record.pid ? ` · PID ${record.pid}` : ""}`,
      content ? `${stream.toUpperCase()} (últimas líneas):\n${content}` : `${stream.toUpperCase()}: (vacío)`,
    ].join("\n\n");
  }

  buildContextSummary(jid: string): string {
    const active = this.list(jid).filter((item) => isLiveStatus(item.status)).slice(0, 8);
    if (!active.length) return "[PROCESOS]\nNo hay procesos persistentes activos.";
    return [
      "[PROCESOS PERSISTENTES ACTIVOS]",
      ...active.map((item) => `- ${item.id} | ${item.name} | ${item.runtime} ${item.entry} | ${item.status}${item.pid ? ` | PID ${item.pid}` : ""}${item.ownerGoalId ? ` | goal ${item.ownerGoalId}` : ""}`),
      "Usa process_logs para inspeccionar errores y process_stop/process_restart para administrar estos procesos; no inicies una segunda instancia sin revisar process_list.",
    ].join("\n");
  }
}
