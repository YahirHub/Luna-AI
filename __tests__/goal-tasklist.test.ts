import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TasklistManager } from "../src/goals/tasklist.ts";
import { WorkspaceManager } from "../src/workspace/workspace-manager.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "luna-goal-tasklist-"));
  const workspace = new WorkspaceManager(join(root, "contexts"));
  const tasklists = new TasklistManager(workspace);
  return { root, workspace, tasklists, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("tasklist interna de goals", () => {
  it("persiste fuera del workdir editable del usuario", () => {
    const f = fixture();
    try {
      const list = f.tasklists.create("user", "Implementar bot", ["Investigar API", "Crear código"], "G-TEST");
      expect(list.goalId).toBe("G-TEST");
      expect(existsSync(join(f.workspace.getUserDir("user"), "goals", "tasklists.json"))).toBe(true);
      expect(existsSync(join(f.workspace.getWorkdir("user"), "tasklists.json"))).toBe(false);
    } finally { f.cleanup(); }
  });

  it("exige evidencia antes de completar un paso", () => {
    const f = fixture();
    try {
      const list = f.tasklists.create("user", "Validación", ["Ejecutar tests"]);
      expect(() => f.tasklists.updateItem("user", list.id, "T1", { status: "completed" })).toThrow();
      const updated = f.tasklists.updateItem("user", list.id, "T1", {
        status: "completed",
        evidence: "npm test terminó con exit code 0",
      });
      expect(updated.items[0]?.status).toBe("completed");
      expect(updated.items[0]?.evidence).toContain("exit code 0");
    } finally { f.cleanup(); }
  });

  it("mantiene como máximo un paso in_progress", () => {
    const f = fixture();
    try {
      const list = f.tasklists.create("user", "Trabajo", ["A", "B", "C"]);
      f.tasklists.updateItem("user", list.id, "T1", { status: "in_progress" });
      const updated = f.tasklists.updateItem("user", list.id, "T2", { status: "in_progress" });
      expect(updated.items.filter((item) => item.status === "in_progress").map((item) => item.id)).toEqual(["T2"]);
      expect(updated.items.find((item) => item.id === "T1")?.status).toBe("pending");
    } finally { f.cleanup(); }
  });
});
