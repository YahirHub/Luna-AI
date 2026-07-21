import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_WEB_AGENT } from "../src/agents/definitions/browser-web.ts";
import { RESEARCHER_WEB_AGENT } from "../src/agents/definitions/researcher-web.ts";
import { TaskRuntime } from "../src/orchestration/task-runtime.ts";
import { WorkspaceManager } from "../src/workspace/workspace-manager.ts";

const roots: string[] = [];
const source = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("identidad visible de agentes", () => {
  it("diferencia navegación real y búsqueda por API", () => {
    expect(BROWSER_WEB_AGENT.backend).toBe("browser-agent");
    expect(RESEARCHER_WEB_AGENT.backend).toBe("api-search");
  });

  it("persiste el backend y lo incluye en el contexto autoritativo", () => {
    const root = join(tmpdir(), `luna-agent-backend-${crypto.randomUUID()}`);
    roots.push(root);
    const workspace = new WorkspaceManager(root);
    const tasks = new TaskRuntime(workspace);
    const task = tasks.create("user", "Trabajo mixto", 2);
    const browser = tasks.createAgent("user", task.record.id, {
      name: "Abrir panel",
      agentType: "browser-web",
      runId: "browser-run",
      agentPath: "tasks/browser",
      prompt: "Abre el panel",
    });
    const search = tasks.createAgent("user", task.record.id, {
      name: "Consultar documentación",
      agentType: "researcher-web",
      runId: "search-run",
      agentPath: "tasks/search",
      prompt: "Busca documentación",
    });

    expect(browser.record.backend).toBe("browser-agent");
    expect(search.record.backend).toBe("api-search");
    expect(tasks.buildContextSummary("user")).toContain("browser-agent (browser-web)");
    expect(tasks.buildContextSummary("user")).toContain("api-search (researcher-web)");
  });

  it("usa scopes separados y agrega identidad del supervisor en los logs", () => {
    const agentRuntime = source("src/agents/agent-runtime.ts");
    const browserRuntime = source("src/browser/browser-runtime.ts");
    const searchRuntime = source("src/search/search-runtime.ts");
    const coordinator = source("src/search/search-coordinator.ts");
    const bot = source("src/bot.ts");

    expect(agentRuntime).toContain("const logScope = `agent.${backend}`");
    expect(browserRuntime).toContain('"browser-agent.runtime"');
    expect(browserRuntime).toContain("agentName: this.options.agentName");
    expect(searchRuntime).toContain('"api-search.runtime"');
    expect(coordinator).toContain('"api-search.queue"');
    expect(bot).toContain("${event.backend} ${event.agentId}");
  });
});
