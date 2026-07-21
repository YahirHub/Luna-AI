import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("autonomía de tareas y browser-web", () => {
  it("solo confirma inicio desde el evento real del runtime", () => {
    const spawn = source("src/agents/spawn-agents-tool.ts");
    expect(spawn).toContain('if (event.type === "agent_started")');
    expect(spawn).toContain('type: "task_registered"');
    expect(spawn).toContain('status: "queued"');
  });

  it("revisa automáticamente la carpeta y envía artefactos al terminar", () => {
    const bot = source("src/bot.ts");
    expect(bot).toContain("reviewBackgroundTask");
    expect(bot).toContain("workspaceManager.listRecursive");
    expect(bot).toContain("sendWorkspacePath");
    expect(bot).toContain("onBackgroundCompleted");
    expect(bot).toContain("onSystemArtifact");
  });

  it("aísla HOME y perfil por ejecución para permitir navegadores concurrentes", () => {
    const runtime = source("src/browser/browser-runtime.ts");
    expect(runtime).toContain('this.persistentHome = join(this.runRuntimeDir, "home")');
    expect(runtime).toContain('this.profileDir = join(this.runRuntimeDir, "profile")');
    expect(runtime).toContain("Cada agente obtiene HOME y perfil propios");
    expect(runtime).toContain("state-save");
  });

  it("incluye snapshot inicial y captura anotada en solicitudes humanas", () => {
    const runtime = source("src/browser/browser-runtime.ts");
    const definition = source("src/agents/definitions/browser-web.ts");
    expect(runtime).toContain("appendInitialSnapshot");
    expect(runtime).toContain('"--annotate"');
    expect(definition).toContain("Nunca abortes por falta de datos");
    expect(definition).toContain("volver a solicitar");
  });
});
