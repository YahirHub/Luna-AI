import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const source = (path: string): string => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");

describe("lazy capabilities y ahorro de contexto", () => {
  it("resuelve el toolset en cada ronda y permite ampliar capacidades sin reiniciar el turno", () => {
    const ai = source("src/ai.ts");
    const bot = source("src/bot.ts");
    expect(ai).toContain("resolveTools?: () => ToolDefinition[]");
    expect(ai).toContain("const resolvedTools = runtimeOptions.resolveTools?.() ?? tools");
    expect(ai).toContain("orderResolvedTools");
    expect(ai).toContain("stableToolOrder");
    expect(bot).toContain('name === "capability_load"');
    expect(bot).toContain("resolveTools: () => getAvailableTools(remoteJid, userText, loadedCapabilities)");
    expect(bot).toContain("filterToolsForTurn(pool, message, session, loaded, pinned)");
  });

  it("mantiene superficies eager pequeñas y difiere mutación/ejecución", () => {
    const workspace = source("src/modules/workspace/module.ts");
    const goals = source("src/modules/goals/module.ts");
    const skills = source("src/modules/skills/module.ts");
    const tts = source("src/modules/tts/module.ts");
    expect(workspace).toContain('{ name: "workspace_read_text" }');
    expect(workspace).toContain('{ name: "workspace_write_text", defer: true }');
    expect(workspace).toContain('{ name: "workspace_exec", defer: true }');
    expect(goals).toContain('{ name: "tasklist_create", defer: true }');
    expect(skills).toContain('{ name: "skill_list", defer: true }');
    expect(tts).toContain('{ name: "tts_list_voices", defer: true }');
    for (const moduleSource of [goals, skills, tts]) expect(moduleSource).not.toContain("always: true");
  });

  it("difiere también instrucciones avanzadas", () => {
    const types = source("src/modules/types.ts");
    const registry = source("src/modules/registry.ts");
    const workspace = source("src/modules/workspace/module.ts");
    expect(types).toContain("loadInstructions?: string[]");
    expect(registry).toContain("module.prompt?.loadInstructions");
    expect(workspace).toContain("loadInstructions:");
  });

  it("no inyecta catálogo completo de skills ni persiste su cuerpo en el historial", () => {
    const bot = source("src/bot.ts");
    const skills = source("src/skills/skill-tools.ts");
    expect(bot).not.toContain("skillManager.buildCatalogForModel()");
    expect(bot).not.toContain("[SKILL GLOBAL CARGADA:");
    expect(skills).toContain('name: "skill_search"');
  });

  it("limita memoria, resumen y resultados grandes", () => {
    const memory = source("src/memory.ts");
    const compaction = source("src/compaction.ts");
    const ai = source("src/ai.ts");
    expect(memory).toContain("MAX_MEMORY_CONTEXT_CHARS = 4_000");
    expect(compaction).toContain("MAX_COMPACTED_SUMMARY_CONTEXT_CHARS = 8_000");
    expect(ai).toContain("RESULTADO GRANDE VIRTUALIZADO");
    expect(ai).toContain('name: "tool_result_read"');
  });

  it("mantiene skills en modo ligero dentro de /goal hasta que realmente hacen falta scripts", () => {
    const goal = source("src/goals/goal-runtime.ts");
    expect(goal).toContain('new Set<string>(["goals", "workspace"])');
    expect(goal).not.toContain('new Set<string>(["goals", "workspace", "skills"])');
    expect(goal).toContain('carga primero la capacidad skills con capability_load');
  });

  it("aplica progressive disclosure también a browser-web y researcher-web", () => {
    const runtime = source("src/agents/agent-runtime.ts");
    const browser = source("src/agents/definitions/browser-web.ts");
    const researcher = source("src/agents/definitions/researcher-web.ts");
    expect(runtime).toContain('name: "agent_capability_load"');
    expect(runtime).toContain("resolveTools: () => toolDefinitions(options.definition, loadedToolGroups)");
    expect(browser).toContain("initialToolNames:");
    expect(browser).toContain("inspect:");
    expect(browser).toContain("auth:");
    expect(researcher).toContain('initialToolNames: ["web_search", "read_url"]');
  });
});
