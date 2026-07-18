import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../src/workspace/workspace-manager.ts";
import { TaskRuntime } from "../src/orchestration/task-runtime.ts";

const roots: string[] = [];
function createWorkspace(): { root: string; workspace: WorkspaceManager } {
  const root = join(tmpdir(), `luna-workspace-${Date.now()}-${crypto.randomUUID()}`);
  roots.push(root);
  return { root, workspace: new WorkspaceManager(root) };
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("WorkspaceManager", () => {
  it("aísla archivos y artefactos por JID", () => {
    const { workspace } = createWorkspace();
    workspace.writeText("uno@s.whatsapp.net", "exports/reporte.md", "usuario uno");
    workspace.writeText("dos@s.whatsapp.net", "exports/reporte.md", "usuario dos");

    expect(workspace.readText("uno@s.whatsapp.net", "exports/reporte.md")).toBe("usuario uno");
    expect(workspace.readText("dos@s.whatsapp.net", "exports/reporte.md")).toBe("usuario dos");

    const artifact = workspace.registerArtifact("uno@s.whatsapp.net", "exports/reporte.md", "test");
    expect(artifact.path).toBe("exports/reporte.md");
    expect(workspace.listArtifacts("uno@s.whatsapp.net")).toHaveLength(1);
    expect(workspace.listArtifacts("dos@s.whatsapp.net")).toHaveLength(0);
  });

  it("impide rutas absolutas y traversal", () => {
    const { workspace } = createWorkspace();
    expect(() => workspace.writeText("user", "../escape.txt", "x")).toThrow();
    expect(() => workspace.writeText("user", "/tmp/escape.txt", "x")).toThrow();
  });

  it("detecta enlaces simbólicos que salen del workdir", () => {
    const { root, workspace } = createWorkspace();
    const external = join(root, "external.txt");
    writeFileSync(external, "secreto");
    const workdir = workspace.getWorkdir("user");
    symlinkSync(external, join(workdir, "escape-link"));
    expect(() => workspace.resolvePath("user", "escape-link", { mustExist: true })).toThrow(/enlace simbólico/i);
  });

  it("limpia todo el workdir y recrea únicamente la estructura base", () => {
    const { workspace } = createWorkspace();
    workspace.writeText("user", "exports/reporte.md", "contenido");
    workspace.writeText("user", "inbox/entrada.txt", "entrada");
    workspace.createTask("user", "investigación");
    workspace.registerArtifact("user", "exports/reporte.md", "test");

    workspace.clearWorkdir("user");

    expect(workspace.list("user", "exports")).toEqual([]);
    expect(workspace.list("user", "inbox")).toEqual([]);
    expect(workspace.list("user", "tasks")).toEqual([]);
    expect(workspace.listArtifacts("user")).toEqual([]);
  });
});

describe("TaskRuntime", () => {
  it("persiste progreso, artefactos y cancelación", () => {
    const { workspace } = createWorkspace();
    const runtime = new TaskRuntime(workspace);
    const created = runtime.create("user", "comparar APIs", 4);
    expect(created.record.status).toBe("running");
    expect(existsSync(workspace.resolvePath("user", created.record.taskPath, { mustExist: true, allowDirectory: true }))).toBe(true);

    runtime.update("user", created.record.id, { completedWorkers: 2, status: "synthesizing" });
    expect(runtime.get("user", created.record.id)?.completedWorkers).toBe(2);
    expect(runtime.cancel("user", created.record.id)).toBe(true);
    expect(runtime.get("user", created.record.id)?.status).toBe("cancelled");
  });
});
