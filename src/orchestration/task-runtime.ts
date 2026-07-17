import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import { writeJsonFileAtomically } from "../storage.ts";

export type TaskStatus = "running" | "synthesizing" | "completed" | "partial" | "failed" | "cancelled";

export interface AgentTaskRecord {
  id: string;
  jid: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  taskPath: string;
  completedWorkers: number;
  totalWorkers: number;
  error?: string;
  artifacts: string[];
}

interface TaskFile {
  version: 1;
  tasks: AgentTaskRecord[];
}

export class TaskRuntime {
  private readonly active = new Map<string, AbortController>();

  constructor(private readonly workspace: WorkspaceManager) {}

  private taskFile(jid: string): string {
    return join(this.workspace.getWorkdir(jid), "tasks.json");
  }

  private load(jid: string): TaskFile {
    try {
      const parsed = JSON.parse(readFileSync(this.taskFile(jid), "utf-8")) as TaskFile;
      return Array.isArray(parsed.tasks) ? parsed : { version: 1, tasks: [] };
    } catch {
      return { version: 1, tasks: [] };
    }
  }

  private save(jid: string, file: TaskFile): void {
    writeJsonFileAtomically(this.taskFile(jid), file);
  }

  create(jid: string, title: string, totalWorkers: number): { record: AgentTaskRecord; signal: AbortSignal } {
    const created = this.workspace.createTask(jid, title);
    const now = new Date().toISOString();
    const record: AgentTaskRecord = {
      id: created.taskId,
      jid,
      title,
      status: "running",
      createdAt: now,
      updatedAt: now,
      taskPath: this.workspace.relativePath(jid, created.path),
      completedWorkers: 0,
      totalWorkers,
      artifacts: [],
    };
    const file = this.load(jid);
    file.tasks.push(record);
    this.save(jid, file);
    const controller = new AbortController();
    this.active.set(`${jid}:${record.id}`, controller);
    return { record, signal: controller.signal };
  }

  update(jid: string, taskId: string, patch: Partial<Omit<AgentTaskRecord, "id" | "jid" | "createdAt">>): AgentTaskRecord | null {
    const file = this.load(jid);
    const task = file.tasks.find((item) => item.id === taskId);
    if (!task) return null;
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    this.save(jid, file);
    if (["completed", "partial", "failed", "cancelled"].includes(task.status)) {
      this.active.delete(`${jid}:${taskId}`);
    }
    return { ...task, artifacts: [...task.artifacts] };
  }

  list(jid: string): AgentTaskRecord[] {
    return this.load(jid).tasks.slice(-20).reverse();
  }

  get(jid: string, taskId: string): AgentTaskRecord | undefined {
    return this.load(jid).tasks.find((item) => item.id === taskId);
  }

  cancel(jid: string, taskId?: string): boolean {
    const records = this.list(jid);
    const target = taskId ? records.find((item) => item.id === taskId) : records.find((item) => item.status === "running" || item.status === "synthesizing");
    if (!target) return false;
    const controller = this.active.get(`${jid}:${target.id}`);
    controller?.abort(new Error("task-cancelled"));
    this.update(jid, target.id, { status: "cancelled", error: "Cancelada por el usuario." });
    return true;
  }
}
