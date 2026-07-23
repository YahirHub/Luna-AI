import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "../ai.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import { writeJsonFileAtomically } from "../storage.ts";

export type TasklistItemStatus = "pending" | "in_progress" | "completed" | "blocked" | "skipped";

export interface TasklistItem {
  id: string;
  text: string;
  status: TasklistItemStatus;
  evidence?: string;
  updatedAt: string;
}

export interface TasklistRecord {
  id: string;
  jid: string;
  title: string;
  goalId?: string;
  createdAt: string;
  updatedAt: string;
  items: TasklistItem[];
}

interface TasklistFile {
  version: 1;
  tasklists: TasklistRecord[];
}

function shortTasklistId(): string {
  return `TL-${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

function cleanText(value: unknown, max = 800): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function normalizeStatus(value: unknown): TasklistItemStatus | null {
  return ["pending", "in_progress", "completed", "blocked", "skipped"].includes(String(value))
    ? String(value) as TasklistItemStatus
    : null;
}

function normalizeTaskMeaning(value: string): string {
  return cleanText(value, 1200)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^resolver verificacion:\s*/i, "")
    .replace(/^t\d+\s*:\s*/i, "")
    .replace(/\[(?:pending|in_progress|blocked|completed|skipped)\]/gi, "")
    .replace(/[^a-z0-9._/@+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function taskMeaningSimilarity(a: string, b: string): number {
  const left = new Set(normalizeTaskMeaning(a).split(/\s+/).filter(Boolean));
  const right = new Set(normalizeTaskMeaning(b).split(/\s+/).filter(Boolean));
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / Math.max(left.size, right.size);
}

export class TasklistManager {
  constructor(private readonly workspace: WorkspaceManager) {}

  private filePath(jid: string): string {
    // Estado interno autoritativo: no se guarda dentro del workdir editable por
    // el agente para impedir que un script o workspace_write falsifique progreso.
    return join(this.workspace.getUserDir(jid), "goals", "tasklists.json");
  }

  private load(jid: string): TasklistFile {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath(jid), "utf8")) as TasklistFile;
      if (parsed?.version === 1 && Array.isArray(parsed.tasklists)) return parsed;
    } catch {}
    return { version: 1, tasklists: [] };
  }

  private save(jid: string, file: TasklistFile): void {
    writeJsonFileAtomically(this.filePath(jid), file);
  }

  create(jid: string, title: string, items: string[] = [], goalId?: string): TasklistRecord {
    const now = new Date().toISOString();
    const record: TasklistRecord = {
      id: shortTasklistId(),
      jid,
      title: cleanText(title, 240) || "Tarea",
      goalId,
      createdAt: now,
      updatedAt: now,
      items: items.map((text, index) => ({
        id: `T${index + 1}`,
        text: cleanText(text),
        status: "pending" as const,
        updatedAt: now,
      })).filter((item) => item.text),
    };
    const file = this.load(jid);
    file.tasklists.push(record);
    // Limitar historial persistente sin tocar listas asociadas a goals recientes.
    if (file.tasklists.length > 80) file.tasklists = file.tasklists.slice(-80);
    this.save(jid, file);
    return structuredClone(record);
  }

  get(jid: string, id?: string): TasklistRecord | undefined {
    const file = this.load(jid);
    const record = id
      ? file.tasklists.find((item) => item.id.toLowerCase() === id.toLowerCase())
      : file.tasklists[file.tasklists.length - 1];
    return record ? structuredClone(record) : undefined;
  }

  getByGoal(jid: string, goalId: string): TasklistRecord | undefined {
    const record = this.load(jid).tasklists.find((item) => item.goalId === goalId);
    return record ? structuredClone(record) : undefined;
  }

  replaceItems(jid: string, id: string, items: Array<{ text: string; status?: TasklistItemStatus; evidence?: string }>): TasklistRecord {
    const file = this.load(jid);
    const record = file.tasklists.find((item) => item.id === id);
    if (!record) throw new Error(`No existe tasklist ${id}.`);
    const now = new Date().toISOString();
    let inProgressSeen = false;
    record.items = items.slice(0, 80).flatMap((input, index) => {
      const text = cleanText(input.text);
      if (!text) return [];
      let status = normalizeStatus(input.status) ?? "pending";
      const evidence = cleanText(input.evidence, 1200) || undefined;
      if (status === "completed" && !evidence) {
        throw new Error(`El paso T${index + 1} no puede marcarse completed sin evidence.`);
      }
      if (status === "in_progress") {
        if (inProgressSeen) status = "pending";
        inProgressSeen = true;
      }
      return [{
        id: `T${index + 1}`,
        text,
        status,
        evidence,
        updatedAt: now,
      }];
    });
    record.updatedAt = now;
    this.save(jid, file);
    return structuredClone(record);
  }

  addItems(jid: string, id: string, texts: string[]): TasklistRecord {
    const file = this.load(jid);
    const record = file.tasklists.find((item) => item.id === id);
    if (!record) throw new Error(`No existe tasklist ${id}.`);
    const now = new Date().toISOString();
    let next = record.items.reduce((max, item) => Math.max(max, Number(item.id.replace(/^T/i, "")) || 0), 0) + 1;
    for (const raw of texts.slice(0, 40)) {
      const text = cleanText(raw);
      if (!text) continue;
      const meaning = normalizeTaskMeaning(text);
      if (record.items.some((item) => item.status !== "skipped" && (
        normalizeTaskMeaning(item.text) === meaning
        || taskMeaningSimilarity(item.text, text) >= 0.88
      ))) continue;
      record.items.push({ id: `T${next++}`, text, status: "pending", updatedAt: now });
    }
    record.updatedAt = now;
    this.save(jid, file);
    return structuredClone(record);
  }

  updateItem(jid: string, id: string, itemId: string, patch: { status?: TasklistItemStatus; text?: string; evidence?: string }): TasklistRecord {
    const file = this.load(jid);
    const record = file.tasklists.find((item) => item.id === id);
    if (!record) throw new Error(`No existe tasklist ${id}.`);
    const item = record.items.find((candidate) => candidate.id.toLowerCase() === itemId.toLowerCase());
    if (!item) throw new Error(`No existe ${itemId} en ${id}.`);
    const now = new Date().toISOString();
    if (patch.status) {
      const incomingEvidence = patch.evidence !== undefined ? cleanText(patch.evidence, 1200) : item.evidence;
      if (patch.status === "completed" && !incomingEvidence) {
        throw new Error(`${item.id} no puede marcarse completed sin evidence verificable.`);
      }
      if (patch.status === "in_progress") {
        for (const candidate of record.items) {
          if (candidate.id !== item.id && candidate.status === "in_progress") {
            candidate.status = "pending";
            candidate.updatedAt = now;
          }
        }
      }
      item.status = patch.status;
    }
    const text = cleanText(patch.text);
    if (text) item.text = text;
    if (patch.evidence !== undefined) item.evidence = cleanText(patch.evidence, 1200) || undefined;
    item.updatedAt = now;
    record.updatedAt = now;
    this.save(jid, file);
    return structuredClone(record);
  }

  progress(record: TasklistRecord): { done: number; actionable: number; total: number; pending: number; blocked: number } {
    const done = record.items.filter((item) => item.status === "completed" || item.status === "skipped").length;
    const blocked = record.items.filter((item) => item.status === "blocked").length;
    const pending = record.items.filter((item) => item.status === "pending" || item.status === "in_progress").length;
    return { done, actionable: Math.max(0, record.items.length - blocked), total: record.items.length, pending, blocked };
  }

  format(record: TasklistRecord): string {
    const icon: Record<TasklistItemStatus, string> = {
      pending: "⬜",
      in_progress: "🔄",
      completed: "✅",
      blocked: "⛔",
      skipped: "⏭️",
    };
    const progress = this.progress(record);
    return [
      `Tasklist ${record.id} — ${record.title}`,
      `Progreso: ${progress.done}/${progress.total} · pendientes ${progress.pending} · bloqueados ${progress.blocked}`,
      ...record.items.map((item) => `${icon[item.status]} ${item.id} ${item.text}${item.evidence ? `\n   Evidencia: ${item.evidence}` : ""}`),
    ].join("\n");
  }
}

export const TASKLIST_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "tasklist_create",
      description: "Crea una tasklist interna persistente para un trabajo de varios pasos. No es un comando visible; el agente la usa para no olvidar requisitos.",
      parameters: { type: "object", properties: { title: { type: "string" }, items: { type: "array", minItems: 1, maxItems: 80, items: { type: "string" } } }, required: ["title", "items"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "tasklist_read",
      description: "Lee la tasklist interna activa o una tasklist concreta. No es un comando de usuario; sirve al agente para mantener progreso real.",
      parameters: { type: "object", properties: { tasklist_id: { type: "string" } }, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "tasklist_replace",
      description: "Reemplaza la tasklist completa por un plan ordenado y verificable. Úsala al inicio de trabajos de varios pasos y mantenla actualizada.",
      parameters: {
        type: "object",
        properties: {
          tasklist_id: { type: "string" },
          items: {
            type: "array", minItems: 1, maxItems: 80,
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked", "skipped"] },
                evidence: { type: "string" },
              },
              required: ["text"], additionalProperties: false,
            },
          },
        },
        required: ["items"], additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tasklist_update",
      description: "Actualiza un paso de la tasklist y registra evidencia. No marques completed sin una acción o verificación real que lo respalde.",
      parameters: {
        type: "object",
        properties: {
          tasklist_id: { type: "string" }, item_id: { type: "string" },
          status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked", "skipped"] },
          text: { type: "string" }, evidence: { type: "string" },
        },
        required: ["item_id"], additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tasklist_add",
      description: "Añade pasos descubiertos durante la ejecución a la tasklist actual sin perder el progreso existente.",
      parameters: { type: "object", properties: { tasklist_id: { type: "string" }, items: { type: "array", minItems: 1, maxItems: 40, items: { type: "string" } } }, required: ["items"], additionalProperties: false },
    },
  },
];

export async function executeTasklistTool(
  name: string,
  args: Record<string, unknown>,
  manager: TasklistManager,
  jid: string,
  fallbackTasklistId?: string,
): Promise<string> {
  try {
    const id = typeof args.tasklist_id === "string" && args.tasklist_id.trim() ? args.tasklist_id.trim() : fallbackTasklistId;
    if (name === "tasklist_create") {
      const title = typeof args.title === "string" ? args.title : "Tarea";
      const items = Array.isArray(args.items) ? args.items.map((value) => cleanText(value)).filter(Boolean) : [];
      if (!items.length) return "Error: items debe contener al menos un paso.";
      return manager.format(manager.create(jid, title, items));
    }
    if (name === "tasklist_read") {
      const record = manager.get(jid, id);
      return record ? manager.format(record) : "Error: no hay una tasklist disponible.";
    }
    if (!id) return "Error: tasklist_id es obligatorio cuando no hay una tasklist activa asociada al goal.";
    if (name === "tasklist_replace") {
      const rawItems = Array.isArray(args.items) ? args.items : [];
      const items = rawItems.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const raw = value as Record<string, unknown>;
        const text = cleanText(raw.text);
        if (!text) return [];
        return [{ text, status: normalizeStatus(raw.status) ?? undefined, evidence: cleanText(raw.evidence, 1200) || undefined }];
      });
      if (!items.length) return "Error: items debe incluir al menos un paso válido.";
      return manager.format(manager.replaceItems(jid, id, items));
    }
    if (name === "tasklist_add") {
      const items = Array.isArray(args.items) ? args.items.map((value) => cleanText(value)).filter(Boolean) : [];
      if (!items.length) return "Error: items debe contener al menos un paso.";
      return manager.format(manager.addItems(jid, id, items));
    }
    if (name === "tasklist_update") {
      const itemId = typeof args.item_id === "string" ? args.item_id.trim() : "";
      if (!itemId) return "Error: item_id es obligatorio.";
      const status = normalizeStatus(args.status) ?? undefined;
      const text = typeof args.text === "string" ? args.text : undefined;
      const evidence = typeof args.evidence === "string" ? args.evidence : undefined;
      return manager.format(manager.updateItem(jid, id, itemId, { status, text, evidence }));
    }
    return `Error: tool de tasklist desconocida: ${name}`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
