import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../src/workspace/workspace-manager.ts";
import { executeAgenticWorkspaceTool } from "../src/workspace/workspace-agentic-tools.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "luna-agentic-workspace-"));
  const workspace = new WorkspaceManager(join(root, "contexts"));
  return { root, workspace, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("herramientas agenticas de workspace", () => {
  it("hace glob, búsqueda, lectura múltiple y patch exacto", async () => {
    const f = fixture();
    try {
      f.workspace.writeText("user", "src/a.ts", "export const answer = 41;\n");
      f.workspace.writeText("user", "src/b.ts", "export const name = 'Luna';\n");

      const glob = await executeAgenticWorkspaceTool("workspace_glob", { pattern: "**/*.ts" }, f.workspace, "user");
      expect(glob).toContain("src/a.ts");
      expect(glob).toContain("src/b.ts");

      const search = await executeAgenticWorkspaceTool("workspace_search", { query: "answer", path: "src" }, f.workspace, "user");
      expect(search).toContain("src/a.ts:1");

      const read = await executeAgenticWorkspaceTool("workspace_read_files", { paths: ["src/a.ts", "src/b.ts"] }, f.workspace, "user");
      expect(read).toContain("answer = 41");
      expect(read).toContain("name = 'Luna'");

      const patch = await executeAgenticWorkspaceTool("workspace_apply_patch", {
        changes: [{ path: "src/a.ts", old_text: "answer = 41", new_text: "answer = 42" }],
      }, f.workspace, "user");
      expect(patch).toContain("Patch aplicado");
      expect(f.workspace.readText("user", "src/a.ts")).toContain("answer = 42");
    } finally { f.cleanup(); }
  });

  it("protege metadatos internos del supervisor", () => {
    const f = fixture();
    try {
      expect(() => f.workspace.writeText("user", "tasks.json", "{}" )).toThrow();
      expect(() => f.workspace.writeText("user", "artifacts.json", "{}" )).toThrow();
    } finally { f.cleanup(); }
  });

  it("rechaza cwd que intenta salir del workdir antes de ejecutar código", async () => {
    const f = fixture();
    try {
      const result = await executeAgenticWorkspaceTool("workspace_exec", {
        runtime: "bash",
        code: "pwd",
        cwd: "../otro-usuario",
      }, f.workspace, "user");
      expect(result.startsWith("Error:")).toBe(true);
      expect(result.toLowerCase()).toContain("workdir");
    } finally { f.cleanup(); }
  });
});
