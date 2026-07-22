import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalRuntime } from "../src/goals/goal-runtime.ts";
import { TasklistManager } from "../src/goals/tasklist.ts";
import { WorkspaceManager } from "../src/workspace/workspace-manager.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "luna-goal-live-"));
  const workspace = new WorkspaceManager(join(root, "contexts"));
  const tasklists = new TasklistManager(workspace);
  const runtime = new GoalRuntime({
    workspace,
    tasklists,
    getModel: () => null,
    getLlmConfig: () => null,
    getTools: () => [],
    executeTool: async () => "ok",
  });
  return { root, workspace, tasklists, runtime, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("control en vivo de goals", () => {
  it("acepta instrucciones nuevas sin ejecutar trabajo dentro del turno conversacional", () => {
    const f = fixture();
    try {
      const jid = "user@test";
      const tasklist = f.tasklists.create(jid, "Goal G-LIVE", ["Implementar", "Verificar"], "G-LIVE");
      const dir = join(f.workspace.getUserDir(jid), "goals");
      mkdirSync(dir, { recursive: true });
      const now = new Date().toISOString();
      writeFileSync(join(dir, "goals.json"), JSON.stringify({ version: 1, goals: [{
        id: "G-LIVE", jid, objective: "Crear bot", status: "running", tasklistId: tasklist.id,
        createdAt: now, updatedAt: now, startedAt: now, iteration: 1, maxIterations: 18,
        noProgressIterations: 0, currentPhase: "executing", currentActivity: "Creando archivos",
        pendingInstructions: [], instructionHistory: [], delegatedTaskIds: [],
      }] }));
      const updated = f.runtime.addInstruction(jid, "Usa Node.js, no Python");
      expect(updated.pendingInstructions).toEqual(["Usa Node.js, no Python"]);
      expect(f.runtime.formatStatus(jid)).toContain("Instrucciones pendientes del usuario: 1");
      expect(f.runtime.formatStatus(jid)).toContain("Nueva instrucción del usuario");
    } finally { f.cleanup(); }
  });

  it("registra actividad específica de una investigación delegada", () => {
    const f = fixture();
    try {
      const jid = "user@test";
      const tasklist = f.tasklists.create(jid, "Goal G-LIVE", ["Investigar", "Implementar"], "G-LIVE");
      const dir = join(f.workspace.getUserDir(jid), "goals");
      mkdirSync(dir, { recursive: true });
      const now = new Date().toISOString();
      writeFileSync(join(dir, "goals.json"), JSON.stringify({ version: 1, goals: [{
        id: "G-LIVE", jid, objective: "Crear bot", status: "running", tasklistId: tasklist.id,
        createdAt: now, updatedAt: now, iteration: 1, maxIterations: 18, noProgressIterations: 0,
      }] }));
      f.runtime.noteDelegatedTask(jid, "G-LIVE", "TASK-1");
      f.runtime.noteActivity(jid, "G-LIVE", "browser-agent A-123 investigando grammY", "spawn_agents", "delegating");
      const goal = f.runtime.get(jid, "G-LIVE");
      expect(goal?.delegatedTaskIds).toEqual(["TASK-1"]);
      expect(goal?.currentPhase).toBe("delegating");
      expect(goal?.currentActivity).toContain("browser-agent");
    } finally { f.cleanup(); }
  });
});
