import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const source = (path: string): string => readFileSync(join(root, path), "utf8");

describe("enrutamiento y mensajes completos de agentes", () => {
  it("envía misiones completas por partes y no conserva el corte histórico de 700 caracteres", () => {
    const bot = source("src/bot.ts");
    expect(bot).toContain("function splitCompleteMessage");
    expect(bot).toContain("Misión completa enviada en ${chunks.length} partes");
    expect(bot).not.toContain("prompt.slice(0, 700)");
    expect(bot).not.toContain("event.prompt.slice(0, 700)");
  });

  it("redirige scraping de dominio a browser-agent y conserva búsquedas rápidas en api-search", () => {
    const spawn = source("src/agents/spawn-agents-tool.ts");
    expect(spawn).toContain("shouldUseBrowserAgentForPrompt");
    expect(spawn).toContain('agent_type: "browser-web"');
    expect(spawn).toContain("routeAgentRequest");
    expect(spawn).toContain("return await executeBrowserWebTool({");
  });

  it("libera controladores y terminadores efímeros al finalizar agentes y tareas", () => {
    const spawn = source("src/agents/spawn-agents-tool.ts");
    const runtime = source("src/orchestration/task-runtime.ts");
    expect(spawn).toContain("releaseAgentRuntime");
    expect(spawn).toContain("releaseTaskRuntime");
    expect(runtime).toContain("releaseAgentRuntime(jid: string, agentId: string)");
    expect(runtime).toContain("releaseTaskRuntime(jid: string, taskId: string)");
  });
});
