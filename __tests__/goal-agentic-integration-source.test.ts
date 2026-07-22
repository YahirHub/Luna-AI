import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("integración goal + coding agent", () => {
  it("mantiene tasklist como tool interna y /goal como único comando", () => {
    const moduleSource = read("src/modules/goals/module.ts");
    expect(moduleSource).toContain('name: "goal"');
    expect(moduleSource).not.toContain('name: "tasklist"');
    expect(moduleSource).toContain('{ name: "tasklist_create" }');
    expect(moduleSource).toContain('{ name: "goal_start" }');
  });

  it("goal_start es terminal para liberar el lock del chat", () => {
    const bot = read("src/bot.ts");
    expect(bot).toContain('terminalTools: [');
    expect(bot).toContain('"goal_start"');
    expect(bot).toContain('toolsCalled.includes("goal_start")');
  });

  it("propaga cancelación del goal a subagentes", () => {
    const spawn = read("src/agents/spawn-agents-tool.ts");
    expect(spawn).toContain("parentSignal?: AbortSignal");
    expect(spawn).toContain("dependencies.tasks.cancel(dependencies.jid, task.record.id)");
    const bot = read("src/bot.ts");
    expect(bot).toContain("parentSignal: signal");
  });

  it("incluye runtimes y sandbox en Docker", () => {
    const docker = read("Dockerfile");
    for (const pkg of ["bubblewrap", "python3", "python3-pip", "python3-venv", "nodejs", "npm", "git"]) {
      expect(docker).toContain(pkg);
    }
  });

  it("browser-agent conoce el flujo de imágenes por Wikimedia Commons", () => {
    const browser = read("src/agents/definitions/browser-web.ts");
    expect(browser).toContain("commons.wikimedia.org");
    expect(browser).toContain("página File:");
    expect(browser).toContain("autor/creator");
    expect(browser).toContain("licencia");
  });
});
