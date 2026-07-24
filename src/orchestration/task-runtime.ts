import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import { writeJsonFileAtomically } from "../storage.ts";

export type TaskStatus = "queued" | "running" | "synthesizing" | "completed" | "partial" | "failed" | "cancelled" | "interrupted";
export type AgentExecutionStatus = "queued" | "running" | "waiting_user" | "completed" | "failed" | "cancelled" | "interrupted";
export type ReviewStatus = "pending" | "reviewed";

export interface AgentTaskRecord {
  id: string;
  jid: string;
  title: string;
  status: TaskStatus;
  reviewStatus: ReviewStatus;
  createdAt: string;
  updatedAt: string;
  taskPath: string;
  completedWorkers: number;
  totalWorkers: number;
  error?: string;
  artifacts: string[];
  /** Petición del usuario que originó la tarea background. */
  originPrompt?: string;
  /** Contexto reciente congelado al lanzar la tarea para completar comparaciones/síntesis. */
  originContext?: string;
}

export interface AgentRunRecord {
  id: string;
  taskId: string;
  jid: string;
  name: string;
  agentType: string;
  runId: string;
  status: AgentExecutionStatus;
  reviewStatus: ReviewStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  agentPath: string;
  promptPreview: string;
  resultPath?: string;
  error?: string;
  activity?: string;
  currentTool?: string;
  lastEventAt?: string;
  waitingFieldName?: string;
  waitingRequestId?: string;
  waitingScreenshotPath?: string;
}

interface TaskFile {
  version: 2;
  tasks: AgentTaskRecord[];
  agents: AgentRunRecord[];
}

interface LegacyTaskFile {
  version?: 1;
  tasks?: Array<Omit<AgentTaskRecord, "reviewStatus"> & { reviewStatus?: ReviewStatus }>;
  agents?: AgentRunRecord[];
}

type AgentTerminator = (reason: Error) => void | Promise<void>;

function isTerminalTask(status: TaskStatus): boolean {
  return ["completed", "partial", "failed", "cancelled", "interrupted"].includes(status);
}

function isTerminalAgent(status: AgentExecutionStatus): boolean {
  return ["completed", "failed", "cancelled", "interrupted"].includes(status);
}

function shortAgentId(): string {
  return `A-${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

export class TaskRuntime {
  private readonly activeTasks = new Map<string, AbortController>();
  private readonly activeAgents = new Map<string, AbortController>();
  private readonly agentTerminators = new Map<string, AgentTerminator>();

  constructor(private readonly workspace: WorkspaceManager) {
    this.recoverInterruptedTasks();
  }

  private taskFile(jid: string): string {
    return join(this.workspace.getWorkdir(jid), "tasks.json");
  }

  private key(jid: string, id: string): string {
    return `${jid}:${id}`;
  }

  private load(jid: string): TaskFile {
    try {
      const parsed = JSON.parse(readFileSync(this.taskFile(jid), "utf-8")) as LegacyTaskFile;
      const tasks = Array.isArray(parsed.tasks)
        ? parsed.tasks.map((task) => ({
            ...task,
            reviewStatus: task.reviewStatus ?? (isTerminalTask(task.status) ? "reviewed" : "pending"),
          }))
        : [];
      const agents = Array.isArray(parsed.agents) ? parsed.agents : [];
      return { version: 2, tasks, agents };
    } catch {
      return { version: 2, tasks: [], agents: [] };
    }
  }

  private save(jid: string, file: TaskFile): void {
    writeJsonFileAtomically(this.taskFile(jid), { ...file, version: 2 });
  }

  private recoverInterruptedTasks(): void {
    try {
      if (!existsSync(this.workspace.contextsDir)) return;
      for (const entry of readdirSync(this.workspace.contextsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const filePath = join(this.workspace.contextsDir, entry.name, "workdir", "tasks.json");
        if (!existsSync(filePath)) continue;
        try {
          const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as LegacyTaskFile;
          if (!Array.isArray(parsed.tasks)) continue;
          let changed = false;
          const now = new Date().toISOString();
          const tasks = parsed.tasks.map((task) => {
            if (task.status === "queued" || task.status === "running" || task.status === "synthesizing") {
              changed = true;
              return { ...task, status: "interrupted" as const, reviewStatus: "pending" as const, updatedAt: now, error: "Luna se reinició mientras la tarea estaba activa." };
            }
            return { ...task, reviewStatus: task.reviewStatus ?? (isTerminalTask(task.status) ? "reviewed" as const : "pending" as const) };
          });
          const agents = (Array.isArray(parsed.agents) ? parsed.agents : []).map((agent) => {
            if (agent.status === "queued" || agent.status === "running" || agent.status === "waiting_user") {
              changed = true;
              return { ...agent, status: "interrupted" as const, reviewStatus: "pending" as const, updatedAt: now, completedAt: now, error: "Luna se reinició mientras el agente estaba activo." };
            }
            return agent;
          });
          if (changed) writeJsonFileAtomically(filePath, { version: 2, tasks, agents });
        } catch {
          // Un registro dañado no debe impedir que Luna inicie.
        }
      }
    } catch {
      // Recuperación best-effort.
    }
  }

  create(
    jid: string,
    title: string,
    totalWorkers: number,
    origin?: { prompt?: string; context?: string },
  ): { record: AgentTaskRecord; signal: AbortSignal } {
    const created = this.workspace.createTask(jid, title);
    const now = new Date().toISOString();
    const record: AgentTaskRecord = {
      id: created.taskId,
      jid,
      title,
      status: "queued",
      reviewStatus: "pending",
      createdAt: now,
      updatedAt: now,
      taskPath: this.workspace.relativePath(jid, created.path),
      completedWorkers: 0,
      totalWorkers,
      artifacts: [],
      originPrompt: origin?.prompt?.trim().slice(0, 16_000) || undefined,
      originContext: origin?.context?.trim().slice(0, 20_000) || undefined,
    };
    const file = this.load(jid);
    file.tasks.push(record);
    this.save(jid, file);
    const controller = new AbortController();
    this.activeTasks.set(this.key(jid, record.id), controller);
    return { record, signal: controller.signal };
  }

  createAgent(jid: string, taskId: string, input: {
    name: string;
    agentType: string;
    runId: string;
    agentPath: string;
    prompt: string;
  }): { record: AgentRunRecord; signal: AbortSignal } {
    const now = new Date().toISOString();
    const record: AgentRunRecord = {
      id: shortAgentId(),
      taskId,
      jid,
      name: input.name.trim() || input.agentType,
      agentType: input.agentType,
      runId: input.runId,
      status: "queued",
      reviewStatus: "pending",
      createdAt: now,
      updatedAt: now,
      agentPath: input.agentPath,
      promptPreview: input.prompt.replace(/\s+/g, " ").trim().slice(0, 240),
    };
    const file = this.load(jid);
    file.agents.push(record);
    this.save(jid, file);
    const controller = new AbortController();
    this.activeAgents.set(this.key(jid, record.id), controller);
    return { record, signal: controller.signal };
  }

  registerAgentTerminator(jid: string, agentId: string, terminator: AgentTerminator): () => void {
    const key = this.key(jid, agentId);
    this.agentTerminators.set(key, terminator);
    return () => {
      if (this.agentTerminators.get(key) === terminator) this.agentTerminators.delete(key);
    };
  }

  /** Libera controladores y terminadores efímeros cuando un agente ya terminó. */
  releaseAgentRuntime(jid: string, agentId: string): void {
    const key = this.key(jid, agentId);
    this.activeAgents.delete(key);
    this.agentTerminators.delete(key);
  }

  /** Libera el controlador efímero de una tarea terminal. Los resultados persistentes se conservan. */
  releaseTaskRuntime(jid: string, taskId: string): void {
    this.activeTasks.delete(this.key(jid, taskId));
  }

  update(jid: string, taskId: string, patch: Partial<Omit<AgentTaskRecord, "id" | "jid" | "createdAt">>): AgentTaskRecord | null {
    const file = this.load(jid);
    const task = file.tasks.find((item) => item.id === taskId);
    if (!task) return null;
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    this.save(jid, file);
    if (isTerminalTask(task.status)) this.activeTasks.delete(this.key(jid, taskId));
    return { ...task, artifacts: [...task.artifacts] };
  }

  updateAgent(jid: string, agentId: string, patch: Partial<Omit<AgentRunRecord, "id" | "jid" | "taskId" | "createdAt">>): AgentRunRecord | null {
    const file = this.load(jid);
    const agent = file.agents.find((item) => item.id === agentId);
    if (!agent) return null;
    const now = new Date().toISOString();
    Object.assign(agent, patch, { updatedAt: now, lastEventAt: patch.lastEventAt ?? now });
    if (patch.status === "running" && !agent.startedAt) agent.startedAt = now;
    if (patch.status && isTerminalAgent(patch.status) && !agent.completedAt) agent.completedAt = now;
    this.save(jid, file);
    if (isTerminalAgent(agent.status)) {
      this.activeAgents.delete(this.key(jid, agentId));
      this.agentTerminators.delete(this.key(jid, agentId));
    }
    return { ...agent };
  }

  list(jid: string): AgentTaskRecord[] {
    return this.load(jid).tasks.slice(-30).reverse();
  }

  listAgents(jid: string, taskId?: string): AgentRunRecord[] {
    const agents = this.load(jid).agents.filter((agent) => !taskId || agent.taskId === taskId);
    return agents.slice(-60).reverse();
  }

  get(jid: string, taskId: string): AgentTaskRecord | undefined {
    return this.load(jid).tasks.find((item) => item.id === taskId);
  }

  getAgent(jid: string, agentId: string): AgentRunRecord | undefined {
    return this.load(jid).agents.find((item) => item.id === agentId);
  }

  findAgent(jid: string, selector: string): AgentRunRecord | undefined {
    const normalized = selector.trim().toLowerCase();
    if (!normalized) return undefined;
    return this.listAgents(jid).find((agent) => agent.id.toLowerCase() === normalized)
      ?? this.listAgents(jid).find((agent) => agent.name.toLowerCase().includes(normalized));
  }

  cancelAll(jid: string): number {
    const records = this.load(jid).tasks.filter((item) => item.status === "queued" || item.status === "running" || item.status === "synthesizing");
    let cancelled = 0;
    for (const target of records) {
      if (this.cancel(jid, target.id)) cancelled += 1;
    }
    return cancelled;
  }

  cancel(jid: string, taskId?: string): boolean {
    const records = this.list(jid);
    const target = taskId
      ? records.find((item) => item.id === taskId)
      : records.find((item) => item.status === "queued" || item.status === "running" || item.status === "synthesizing");
    if (!target || isTerminalTask(target.status)) return false;
    const reason = new Error("task-cancelled");
    this.activeTasks.get(this.key(jid, target.id))?.abort(reason);
    for (const agent of this.listAgents(jid, target.id).filter((item) => !isTerminalAgent(item.status))) {
      this.cancelAgent(jid, agent.id, "Cancelado junto con la tarea padre.");
    }
    this.update(jid, target.id, { status: "cancelled", reviewStatus: "pending", error: "Cancelada por el usuario." });
    return true;
  }

  cancelAgent(jid: string, selector: string, message = "Cancelado por el usuario."): boolean {
    const target = this.findAgent(jid, selector);
    if (!target || isTerminalAgent(target.status)) return false;
    const reason = new Error("agent-cancelled");
    this.activeAgents.get(this.key(jid, target.id))?.abort(reason);
    const terminator = this.agentTerminators.get(this.key(jid, target.id));
    if (terminator) void Promise.resolve(terminator(reason)).catch(() => undefined);
    this.updateAgent(jid, target.id, { status: "cancelled", reviewStatus: "pending", error: message });
    return true;
  }

  reviewTask(jid: string, taskId: string): AgentTaskRecord | null {
    const task = this.get(jid, taskId);
    if (!task || !isTerminalTask(task.status)) return null;
    const updated = this.update(jid, taskId, { reviewStatus: "reviewed" });
    const file = this.load(jid);
    let changed = false;
    for (const agent of file.agents) {
      if (agent.taskId === taskId && isTerminalAgent(agent.status) && agent.reviewStatus !== "reviewed") {
        agent.reviewStatus = "reviewed";
        agent.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) this.save(jid, file);
    return updated;
  }

  reviewAgent(jid: string, selector: string): AgentRunRecord | null {
    const agent = this.findAgent(jid, selector);
    if (!agent || !isTerminalAgent(agent.status)) return null;
    const updated = this.updateAgent(jid, agent.id, { reviewStatus: "reviewed" });
    const siblings = this.listAgents(jid, agent.taskId);
    if (siblings.length > 0 && siblings.every((item) => isTerminalAgent(item.status) && item.reviewStatus === "reviewed")) {
      this.update(jid, agent.taskId, { reviewStatus: "reviewed" });
    }
    return updated;
  }

  updateAgentActivity(jid: string, agentId: string, activity: string, currentTool?: string): AgentRunRecord | null {
    return this.updateAgent(jid, agentId, {
      activity: activity.trim().slice(0, 240),
      currentTool: currentTool?.trim() || undefined,
    });
  }

  buildContextSummary(jid: string): string {
    const tasks = this.list(jid);
    const agents = this.listAgents(jid);
    const active = agents.filter((agent) => ["queued", "running", "waiting_user"].includes(agent.status)).slice(0, 8);
    const pending = agents.filter((agent) => isTerminalAgent(agent.status) && agent.reviewStatus === "pending").slice(0, 8);
    if (active.length === 0 && pending.length === 0) return "";
    const lines = ["[TAREAS DE FONDO — estado autoritativo]"];
    if (active.length > 0) {
      lines.push("Activos:");
      for (const agent of active) {
        const task = tasks.find((item) => item.id === agent.taskId);
        const detail = agent.activity ? ` | ahora: ${agent.activity}` : agent.currentTool ? ` | tool: ${agent.currentTool}` : "";
        const waiting = agent.waitingFieldName ? ` | espera: ${agent.waitingFieldName}` : "";
        lines.push(`- ${agent.id} \"${agent.name}\" | ${agent.agentType} | ${agent.status}${detail}${waiting} | tarea ${task?.id ?? agent.taskId}: ${task?.title ?? "sin título"}`);
      }
    }
    if (pending.length > 0) {
      lines.push("Terminados pendientes de revisión:");
      for (const agent of pending) {
        lines.push(`- ${agent.id} "${agent.name}" | ${agent.status} | tarea ${agent.taskId} | resultado: ${agent.resultPath ?? "registrado en la tarea"}`);
      }
    }
    lines.push("Usa task_status para estado exacto y task_inspect para leer resultados, eventos, carpeta y artefactos. También están task_cancel/task_cancel_all y agent_status/agent_cancel. El sistema revisa automáticamente las tareas al terminar; no afirmes que siguen activas si aquí aparecen terminales.");
    return lines.join("\n");
  }
}
